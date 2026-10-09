/**
 * dsh-free-auto — 客户端半身：会话页右下角的"模型速切"悬浮按钮。
 *
 * 这是一个由 ModuleLoader 直接加载的 classic script（没有打包步骤），因此只
 * require('react')，不 import 任何 Harness 客户端包。它做四件事：
 *
 *   0. 列表第一行是 Auto-Free（宿主半身注册的虚拟路由）：选中它以后由宿主自动路由到
 *      列表最上方的模型——同一个会话不切换，命中限流/额度就冷凝重扫换下一个；
 *   1. 轮询宿主半身的 GET /api/free-auto/models，拿到已排好序的模型列表
 *      （顺序由宿主决定：可用性 → 多模态 → 首 token 延迟 → 上下文 → 输出上限）；
 *   2. 每行显示可用性、首 token 延迟、最近一次探测时间等字段；不可用/限流的模型
 *      收在「展开已隐藏」下面，点开能看到不可用的原因；
 *   3. 「重新探测」按钮调用子插件自己的 POST /api/our-free-model/reprobe（同源请求
 *      能过它的准入检查），再隔几次打掉宿主缓存重读，结果是稳定的；
 *   4. 从会话的 modelSelection 投影读出当前模型（内置模型选择器改了也能跟上），
 *      点某个模型名时调用 DSH 自带的 Remote：ctx.remote.session.selectModel(...)
 *      —— 与内置选择器走的是同一条路径（写入会话的 "model/selection" 事件，
 *      下一次请求即生效，并同步为该部署的默认模型）。
 *
 * 故意不传 reasoningEffort：宿主会用目标模型自己的 defaultEffort 补全，所以既
 * 不会因为当前全局档位在目标模型上不存在而被拒（UNSUPPORTED_REASONING_EFFORT），
 * 也不用替用户猜档位。
 *
 * 挂载点是 conversation.input.overlay（kind: list / scope: session，声明见
 * @deepseek-ai/dsh-client-ui-conversation 的 slots 契约），会话作用域的插槽会把
 * sessionId 作为 props 传进来。元素用 position: fixed 固定，所以不会随内容滚动。
 */
window.__ModuleLoader__.load({
  id: 'dsh-free-auto',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const LIST_URL = '/api/free-auto/models'
    const REFRESH_URL = '/api/free-auto/refresh'
    /** 子插件自己的接口：同源请求能过它的 trust fence（见宿主半身的说明）。 */
    const REPROBE_URL = '/api/our-free-model/reprobe'
    const POLL_MS = 60_000
    const SYNC_MS = 4_000
    /** 鼠标离开 widget 范围后多久自动收回列表：留出从按钮移到面板那 8px 缝隙的时间。 */
    const LEAVE_CLOSE_MS = 650
    /** 触发重探后隔多久打掉宿主缓存重读一次（子插件是异步探一整轮）。 */
    const REPROBE_WAITS = [2_500, 5_000, 9_000]
    const STYLE_ID = 'dsh-free-auto-style'
    const SLOT = 'conversation.input.overlay'

    const CSS = `
.fa-root {
  position: fixed;
  right: 18px;
  bottom: 108px;
  z-index: 60;
  font-size: 13px;
  line-height: 1.45;
  color: var(--dsw-alias-text-secondary, #b9bcc4);
}
.fa-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 6px 11px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(255, 255, 255, 0.14));
  border-radius: 999px;
  background: var(--dsw-alias-bg-secondary, #23242a);
  color: inherit;
  font: inherit;
  cursor: pointer;
  opacity: 0.55;
  backdrop-filter: blur(6px);
  transition: opacity 120ms ease;
}
.fa-root:hover .fa-toggle,
.fa-toggle-open { opacity: 1; }
.fa-toggle-icon { font-size: 14px; }
.fa-toggle-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fa-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  width: 340px;
  max-height: 64vh;
  overflow-y: auto;
  padding: 10px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(255, 255, 255, 0.14));
  border-radius: 12px;
  background: var(--dsw-alias-bg-secondary, #23242a);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.38);
}
.fa-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 4px 8px; }
.fa-title { color: var(--dsw-alias-text-primary, #f2f3f5); font-weight: 600; }
.fa-sub { flex: 1; min-width: 0; font-size: 12px; opacity: 0.7; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fa-sub-error { color: var(--dsw-alias-text-error, #ff8a80); opacity: 1; }
.fa-refresh {
  flex: none;
  padding: 3px 9px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(255, 255, 255, 0.14));
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.fa-refresh:hover { background: var(--dsw-alias-bg-tertiary, rgba(255, 255, 255, 0.06)); }
.fa-refresh:disabled { opacity: 0.55; cursor: default; }
.fa-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
button.fa-row:hover { background: var(--dsw-alias-bg-tertiary, rgba(255, 255, 255, 0.06)); }
.fa-row-active { background: var(--dsw-alias-bg-tertiary, rgba(255, 255, 255, 0.06)); cursor: default; }
.fa-row-dim { opacity: 0.72; }
.fa-row-static { cursor: default; }
.fa-row-auto .fa-name { font-weight: 600; }
.fa-row-auto .fa-meta { opacity: 0.85; }
.fa-divider { height: 1px; margin: 4px 6px; background: var(--dsw-alias-border-secondary, rgba(255, 255, 255, 0.1)); }
.fa-rank { width: 16px; opacity: 0.55; font-variant-numeric: tabular-nums; }
.fa-info { flex: 1; min-width: 0; }
.fa-name { display: block; color: var(--dsw-alias-text-primary, #f2f3f5); }
.fa-meta { display: block; font-size: 12px; opacity: 0.7; }
.fa-detail { display: block; font-size: 12px; opacity: 0.6; }
.fa-mark { flex: none; font-size: 12px; padding: 1px 6px; border-radius: 999px; background: var(--dsw-alias-bg-tertiary, rgba(255, 255, 255, 0.08)); }
.fa-mark-active { color: var(--dsw-alias-text-primary, #f2f3f5); }
.fa-more {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 6px 8px;
  border: 0;
  border-top: 1px solid var(--dsw-alias-border-secondary, rgba(255, 255, 255, 0.1));
  border-radius: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: left;
  opacity: 0.7;
  cursor: pointer;
}
.fa-more:hover { opacity: 1; }
.fa-foot { padding: 8px 4px 2px; font-size: 12px; opacity: 0.55; }
`

    function formatTokens(value) {
      if (!Number.isFinite(value) || value <= 0) return '—'
      if (value >= 1_048_576) {
        const millions = value / 1_048_576
        return `${millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10}M`
      }
      if (value >= 1024) return `${Math.round(value / 1024)}K`
      return String(value)
    }

    function formatMs(value) {
      if (!Number.isFinite(value) || value <= 0) return ''
      return value >= 1000 ? `${Math.round(value / 100) / 10}s` : `${Math.round(value)}ms`
    }

    function formatAgo(at) {
      if (!Number.isFinite(at) || at <= 0) return ''
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
      if (seconds < 90) return '刚刚'
      const minutes = Math.round(seconds / 60)
      if (minutes < 90) return `${minutes} 分钟前`
      const hours = Math.round(minutes / 60)
      if (hours < 36) return `${hours} 小时前`
      return `${Math.round(hours / 24)} 天前`
    }

    const rowKey = (row) => `${row.provider}\u0000${row.model}`
    const rowName = (row) => String(row?.name || row?.model || '')
    const samePick = (a, b) => Boolean(a && b && a.provider === b.provider && a.model === b.model)

    const STATE_LABELS = {
      available: '可用',
      unknown: '未探测',
      throttled: '限流',
      'region-blocked': '地区受限',
      unavailable: '不可用',
    }
    const stateLabel = (row) => STATE_LABELS[row?.state] ?? ''

    /** 一行的小字：可用性 · 模态 · 首 token 延迟 · 上下文 · 输出 · 探测时间 · 档位数。 */
    function metaLine(row) {
      const parts = []
      const state = stateLabel(row)
      if (state) parts.push(state)
      parts.push(row.vision ? '视觉' : '纯文本')
      const ttft = formatMs(row.ttftMs)
      if (ttft) parts.push(`${row.ttftSource === 'probe' ? '探测首字' : '首字'} ${ttft}`)
      parts.push(formatTokens(row.contextWindow))
      if (row.maxTokens) parts.push(`输出 ${formatTokens(row.maxTokens)}`)
      const ago = formatAgo(row.probedAt)
      if (ago) parts.push(`探测 ${ago}`)
      const rungs = row.reasoning?.efforts?.length ?? 0
      if (rungs) parts.push(`${rungs} 档思考`)
      return parts.join(' · ')
    }

    /** 被折叠那一组的说明：状态 + 不可用原因 + 探测时间。 */
    function hiddenDetail(row) {
      const parts = []
      if (row.detail) parts.push(String(row.detail))
      const ago = formatAgo(row.probedAt)
      if (ago) parts.push(`探测 ${ago}`)
      const calls = Number.isFinite(row.calls) ? row.calls : null
      const failed = Number.isFinite(row.failed) ? row.failed : null
      if (calls) parts.push(`最近 ${calls} 次调用失败 ${failed ?? 0} 次`)
      return parts.join(' · ')
    }

    function titleFor(row) {
      const parts = [`${row.provider} / ${row.model}`]
      if (row.detail) parts.push(String(row.detail))
      if (Number.isFinite(row.ttftMs)) {
        parts.push(`${row.ttftSource === 'stats' ? '实测平均' : '探测'}首 token ${formatMs(row.ttftMs)}`)
      }
      if (Number.isFinite(row.probeTtftMs) && Number.isFinite(row.avgTtftMs)) {
        parts.push(`最近一次探测 ${formatMs(row.probeTtftMs)}`)
      }
      if (Number.isFinite(row.latencyMs)) parts.push(`探测往返 ${formatMs(row.latencyMs)}`)
      if (Number.isFinite(row.tps)) parts.push(`解码 ${row.tps} tps`)
      const rungs = (row.reasoning?.efforts ?? []).map((effort) => effort.name || effort.id)
      if (rungs.length) parts.push(`档位 ${rungs.join('/')}`)
      return parts.join('\n')
    }

    /** The session's own selection, i.e. exactly what the built-in picker reads. */
    function readPick(sessions, sessionId) {
      try {
        const face = sessions?.binding?.(sessionId)?.session?.projections?.faceOf?.('modelSelection')
        const state = face?.getSnapshot?.()
        const pick = state?.next ?? state?.lastUsed
        return pick ? { provider: String(pick.provider), model: String(pick.model) } : null
      } catch {
        return null
      }
    }

    function isSubagentSession(sessions, sessionId) {
      try {
        return sessions?.subagentAddress?.(sessionId) !== undefined
      } catch {
        return false
      }
    }

    function Switcher({ sessionId, sessions, remote }) {
      const [snapshot, setSnapshot] = useState(null)
      const [current, setCurrent] = useState(() => readPick(sessions, sessionId))
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState('')
      const [probing, setProbing] = useState(false)
      const [showHidden, setShowHidden] = useState(false)
      const [error, setError] = useState('')
      const rootRef = useRef(null)
      const leaveTimer = useRef(null)
      const aliveRef = useRef(true)

      useEffect(
        () => () => {
          aliveRef.current = false
        },
        [],
      )

      /** force 走 POST /refresh：跳过宿主 10s 的目录缓存，重新读一遍上游。 */
      const load = useCallback(
        async ({ force = false } = {}) => {
          const base = force ? REFRESH_URL : LIST_URL
          // sessionId 只是让宿主把这个会话当前的 Auto-Free 选举一起报回来。
          const url = sessionId ? `${base}?sessionId=${encodeURIComponent(sessionId)}` : base
          const response = await fetch(url, {
            method: force ? 'POST' : 'GET',
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (aliveRef.current) {
            setSnapshot(data)
            setError('')
          }
          return data
        },
        [sessionId],
      )

      useEffect(() => {
        const tick = () => {
          if (document.hidden) return
          void load().catch((failure) => {
            if (aliveRef.current) setError(String(failure?.message ?? failure))
          })
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        document.addEventListener('visibilitychange', tick)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', tick)
        }
      }, [load])

      useEffect(() => {
        const sync = () => setCurrent(readPick(sessions, sessionId))
        sync()
        let unsubscribe
        try {
          const face = sessions?.binding?.(sessionId)?.session?.projections?.faceOf?.('modelSelection')
          unsubscribe = face?.subscribe?.(sync)
        } catch {
          // the projection is not reachable yet; the timer below covers it
        }
        const timer = setInterval(sync, SYNC_MS)
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe()
          clearInterval(timer)
        }
      }, [sessions, sessionId])

      /** 点面板外任意处、或按 Esc，都收回列表。 */
      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const root = rootRef.current
          if (root && event.target instanceof Node && root.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      /** 鼠标移出后延迟收回；期间移回（含从按钮移到面板的缝隙）就取消。 */
      const cancelLeave = useCallback(() => {
        if (leaveTimer.current !== null) {
          clearTimeout(leaveTimer.current)
          leaveTimer.current = null
        }
      }, [])
      useEffect(() => cancelLeave, [cancelLeave])
      const onMouseEnter = useCallback(() => cancelLeave(), [cancelLeave])
      const onMouseLeave = useCallback(
        (event) => {
          if (!open) return
          // mouseleave 不会在进入后代时触发；这里再挡一次保险。
          if (event?.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
          cancelLeave()
          leaveTimer.current = setTimeout(() => {
            leaveTimer.current = null
            setOpen(false)
          }, LEAVE_CLOSE_MS)
        },
        [cancelLeave, open],
      )

      const switchTo = useCallback(
        async (row) => {
          setBusy(rowKey(row))
          setError('')
          try {
            // No reasoningEffort on purpose: the target model's own default is used
            // (for the Auto-Free route the host advertises the union ladder).
            const result = await remote.session.selectModel({
              sessionId,
              provider: row.provider,
              model: row.model,
            })
            if (!result?.ok) {
              const failure = result?.error
              throw new Error(failure ? `${failure.code}: ${failure.message}` : '切换失败')
            }
            setCurrent({ provider: row.provider, model: row.model })
            setOpen(false)
          } catch (failure) {
            setError(String(failure?.message ?? failure))
          } finally {
            setBusy('')
          }
        },
        [remote, sessionId],
      )

      /** 让子插件立刻重探一轮，然后隔几次打掉宿主缓存把结果读回来。 */
      const reprobe = useCallback(async () => {
        if (probing) return
        setProbing(true)
        setError('')
        try {
          const response = await fetch(REPROBE_URL, { method: 'POST', cache: 'no-store' })
          if (!response.ok) throw new Error(`重新探测失败：HTTP ${response.status}`)
          for (const wait of REPROBE_WAITS) {
            await new Promise((resolve) => setTimeout(resolve, wait))
            await load({ force: true })
          }
        } catch (failure) {
          if (aliveRef.current) setError(String(failure?.message ?? failure))
        } finally {
          if (aliveRef.current) setProbing(false)
        }
      }, [load, probing])

      const models = Array.isArray(snapshot?.models) ? snapshot.models : []
      const hiddenModels = Array.isArray(snapshot?.hiddenModels) ? snapshot.hiddenModels : []
      // Auto-Free 永远排在第一位：选中它以后由宿主自动路由到列表最上方的模型。
      const auto = snapshot?.auto
      const autoRow =
        auto?.available && auto.provider && auto.model
          ? [
              {
                provider: String(auto.provider),
                model: String(auto.model),
                name: String(auto.name || 'Auto-Free'),
                auto: true,
                rank: '★',
                meta: auto.elected
                  ? `自动路由 · 当前 → ${auto.elected.name || auto.elected.model}`
                  : '自动路由到列表最上方 · 会话内锁定',
                title: 'Auto-Free：自动使用列表最上方的模型；同一个会话不切换，命中限流/额度就冷凝重扫并换下一个可用模型（子智能体避开最优模型）。',
              },
            ]
          : []
      const visible = [...autoRow, ...models]
      if (!visible.length && !hiddenModels.length) return null
      const fallback = snapshot?.current
        ? { provider: String(snapshot.current.provider), model: String(snapshot.current.model) }
        : null
      const effective = current ?? fallback
      const activeRow = visible.find((row) => samePick(row, effective))
      const label = activeRow
        ? activeRow.auto && auto?.elected
          ? `Auto-Free · ${auto.elected.name || auto.elected.model}`
          : rowName(activeRow)
        : busy
          ? '切换中…'
          : '选择模型'
      const foldedStates = Array.from(new Set(hiddenModels.map((row) => stateLabel(row)).filter(Boolean)))

      return h(
        'div',
        {
          className: 'fa-root',
          ref: rootRef,
          onMouseEnter,
          onMouseLeave,
        },
        open &&
          h(
            'div',
            { className: 'fa-panel', role: 'dialog', 'aria-label': '模型速切' },
            h(
              'div',
              { className: 'fa-head' },
              h('span', { className: 'fa-title' }, '模型速切'),
              h(
                'span',
                { className: `fa-sub${error ? ' fa-sub-error' : ''}` },
                error ||
                  `${visible.length} 个可选${hiddenModels.length ? ` · ${hiddenModels.length} 个已折叠` : ''}`,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'fa-refresh',
                  disabled: probing,
                  title: '让 dsh-our-free-model 立刻重新探测一轮（它会自己限速）',
                  onClick: () => void reprobe(),
                },
                probing ? '探测中…' : '重新探测',
              ),
            ),
            visible.map((row) => {
              const active = samePick(row, effective)
              const switching = busy === rowKey(row)
              return h(
                React.Fragment,
                { key: rowKey(row) },
                h(
                  'button',
                  {
                    type: 'button',
                    className: `fa-row${row.auto ? ' fa-row-auto' : ''}${active ? ' fa-row-active' : ''}${
                      !row.auto && row.state && row.state !== 'available' ? ' fa-row-dim' : ''
                    }`,
                    title: row.auto ? row.title : titleFor(row),
                    onClick: () => {
                      if (!active && !busy) void switchTo(row)
                    },
                  },
                  h('span', { className: 'fa-rank' }, String(row.rank ?? '')),
                  h(
                    'span',
                    { className: 'fa-info' },
                    h('span', { className: 'fa-name' }, rowName(row)),
                    h('span', { className: 'fa-meta' }, row.auto ? row.meta : metaLine(row)),
                  ),
                  switching
                    ? h('span', { className: 'fa-mark' }, '切换中')
                    : active
                      ? h('span', { className: 'fa-mark fa-mark-active' }, '当前')
                      : row.auto
                        ? h('span', { className: 'fa-mark' }, '自动')
                        : row.reasoning?.defaultEffort
                          ? h('span', { className: 'fa-mark' }, String(row.reasoning.defaultEffort))
                          : null,
                ),
                row.auto && h('div', { className: 'fa-divider' }),
              )
            }),
            hiddenModels.length > 0 &&
              h(
                'button',
                {
                  type: 'button',
                  className: 'fa-more',
                  'aria-expanded': showHidden,
                  onClick: () => setShowHidden((value) => !value),
                },
                `${showHidden ? '收起' : '展开'} ${hiddenModels.length} 个不可用模型${
                  foldedStates.length ? `（${foldedStates.join(' / ')}）` : ''
                }`,
              ),
            showHidden &&
              hiddenModels.map((row) =>
                h(
                  'div',
                  { key: `hidden-${rowKey(row)}`, className: 'fa-row fa-row-static fa-row-dim', title: titleFor(row) },
                  h('span', { className: 'fa-rank' }, '·'),
                  h(
                    'span',
                    { className: 'fa-info' },
                    h('span', { className: 'fa-name' }, rowName(row)),
                    h('span', { className: 'fa-meta' }, metaLine(row)),
                    hiddenDetail(row) && h('span', { className: 'fa-detail' }, hiddenDetail(row)),
                  ),
                ),
              ),
            h(
              'div',
              { className: 'fa-foot' },
              `Auto-Free = 自动用最上方的模型 · 按 可用 › 多模态 › 首字延迟 › 上下文 › 输出上限 排序${
                Array.isArray(snapshot?.hideStates) && snapshot.hideStates.length
                  ? ` · 折叠 ${snapshot.hideStates.map((state) => STATE_LABELS[state] ?? state).join('/')}`
                  : ''
              }`,
            ),
          ),
        h(
          'button',
          {
            type: 'button',
            className: `fa-toggle${open ? ' fa-toggle-open' : ''}`,
            title: effective ? `当前：${effective.provider}/${effective.model}` : '选择模型',
            onClick: () => setOpen((value) => !value),
          },
          h('span', { className: 'fa-toggle-icon' }, '⇄'),
          h('span', { className: 'fa-toggle-label' }, label),
        ),
      )
    }

    const inject = ['slots', 'sessions', 'remote', 'remote.session']

    function apply(ctx) {
      const ensureStyle = () => {
        if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return () => {}
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.dataset.plugin = 'dsh-free-auto'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }
      // The floating layout lives in CSS, so it must land even if this shell has
      // no ctx.effect to own the cleanup.
      if (typeof ctx.effect === 'function') ctx.effect(ensureStyle, 'free-auto: widget styles')
      else ensureStyle()

      ctx.slots.inject(SLOT, () =>
        ctx.slots.register({ name: SLOT, id: 'free-auto-switcher', order: 60 }, (props) => {
          const sessionId = props?.sessionId
          if (!sessionId || isSubagentSession(ctx.sessions, sessionId)) return null
          return h(Switcher, { sessionId, sessions: ctx.sessions, remote: ctx.remote })
        }),
      )
    }

    return { name: 'free-auto', inject, apply }
  },
})