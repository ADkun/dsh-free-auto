/**
 * dsh-free-auto — Auto-Free 路由的离线行为测试。
 *
 * smoke.mjs 只覆盖"列表/排序/折叠/HTTP 载荷"这条静态表面；这个文件专门覆盖
 * 宿主半身注册的那条虚拟路由（provider `free-auto` / model `auto-free`）：
 *
 *   1. 广告与元数据：没有候选就不广告（选择器里不出现空分组）；
 *   2. 选举与会话内锁定：同一个会话第二条消息继续用同一个模型，即便列表头变了；
 *   3. 限流/额度：失败被吃掉，自动重扫列表并换下一个可用模型，会话不中断；
 *   4. 已经吐过内容就不再换（不能把半截回答换到另一个模型上）；
 *   5. 非切换类错误原样上抛、选举不受影响；
 *   6. 重试次数上限，且不会把同一个模型试两遍；
 *   7. 子智能体避让：非首位已探测模型里随机挑一个（首字延迟 ≤ 最优的 5 倍），
 *      退化顺序：只有一个已探测 → 未探测里随机 → 最优；
 *   8. 不可用/限流的模型本来就进不了列表；
 *   9. 首字超时看门狗换模型；
 *  10. 思考档位投影（请求档位在目标模型上不存在时的降级）；
 *  11. HTTP 载荷里 Auto-Free 行与该会话的选举。
 *
 * 用临时 DSH_HOME 写 availability.json / stats.json，因此排名与可用性是确定的。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'

const DSH_HOME = mkdtempSync(join(tmpdir(), 'free-auto-router-'))
process.env.DSH_HOME = DSH_HOME

/** 跑完（含断言失败退出）都回收临时 HOME，别在 %TEMP% 里堆 free-auto-router-*。 */
process.on('exit', () => rmSync(DSH_HOME, { recursive: true, force: true }))

const ROUTE = 'free-auto'
const AUTO_MODEL = 'auto-free'
const MAIN = 'our-free-model'
const REGION = 'our-free-model-region'

function writeAvailability(results) {
  const dir = join(DSH_HOME, 'our-free-model')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'availability.json'), JSON.stringify({ version: 1, at: Date.now(), egress: null, results }))
}

function writeStats(models = {}) {
  const day = { input: 0, output: 0, reasoning: 0, cacheRead: 0, calls: 0, failed: 0 }
  writeFileSync(
    join(DSH_HOME, 'our-free-model', 'stats.json'),
    JSON.stringify({ version: 3, models: {}, days: { '2026-10-09': { models: { ...day, ...models } } }, samples: [] }),
  )
}

const at = () => Date.now()
const probed = (ttftMs, latencyMs = ttftMs + 200) => ({ state: 'available', detail: '', latencyMs, ttftMs, at: at() })
const raw = (detail = '还没探测过') => ({ state: 'unknown', detail, at: at() })

/** 目录：m-best（视觉 + 1M + 首字 1s）必须排第一。 */
const DETAILS = {
  'm-best': { name: 'M Best', vision: true, contextWindow: 1_000_000, maxTokens: 32_768, efforts: ['light', 'deep'], defaultEffort: 'light' },
  'm-mid': { name: 'M Mid', vision: false, contextWindow: 262_144, maxTokens: 16_384, efforts: ['light', 'balanced'], defaultEffort: 'balanced' },
  'm-slow': { name: 'M Slow', vision: false, contextWindow: 131_072, maxTokens: 8_192, efforts: ['light'], defaultEffort: 'light' },
  'm-raw': { name: 'M Raw', vision: false, contextWindow: 131_072, maxTokens: 8_192, efforts: ['light', 'high'], defaultEffort: 'high' },
  'm-new': { name: 'M New', vision: true, contextWindow: 2_000_000, maxTokens: 65_536, efforts: ['light'], defaultEffort: 'light' },
}

function catalogRows(ids = ['m-best', 'm-mid', 'm-slow', 'm-raw']) {
  return ids.map((id) => ({ provider: MAIN, id, name: DETAILS[id].name, inputModalities: DETAILS[id].vision ? ['text', 'image'] : ['text'] }))
}

let LIST = ['m-best', 'm-mid', 'm-slow', 'm-raw']
const CATALOG = { [MAIN]: catalogRows(LIST), [REGION]: [] }

function reset() {
  CATALOG[MAIN] = catalogRows(LIST)
  const results = {}
  for (const id of LIST) {
    results[id] = id === 'm-raw' ? raw() : probed(id === 'm-best' ? 1000 : id === 'm-mid' ? 2000 : id === 'm-new' ? 500 : 9000)
  }
  writeAvailability(results)
  writeStats()
}

function makeCtx({ config = {}, script, selection, subagents = [] } = {}) {
  const calls = { listModels: 0, streams: [] }
  const routes = []
  const logs = []
  const disposes = []
  const services = new Map()
  let registered

  const effect = (cb) => {
    const dispose = cb()
    if (typeof dispose === 'function') disposes.push(dispose)
    return dispose
  }

  const ctx = {
    logger: { info: (line) => logs.push(['info', line]), warn: (line) => logs.push(['warn', line]) },
    llm: {
      registerAdapter(providers, adapter) {
        registered = { providers, adapter }
        return Object.assign(() => {}, { replace: () => {} })
      },
      providerRetryPolicy() {
        return { maxRetries: 2, retryableCodes: ['SERVER'] }
      },
      async listProviders() {
        return Object.keys(CATALOG).map((id) => ({ id, name: id }))
      },
      async listModels(provider) {
        calls.listModels += 1
        if (!(provider in CATALOG)) throw Object.assign(new Error('unknown provider'), { code: 'PROVIDER_NOT_FOUND' })
        return CATALOG[provider]
      },
      async resolveModelInfo(provider, model) {
        const row = DETAILS[model]
        if (!row) throw new Error(`unknown model: ${model}`)
        return {
          provider,
          id: model,
          name: row.name,
          inputModalities: row.vision ? ['text', 'image'] : ['text'],
          context: { contextWindow: row.contextWindow },
          defaultMaxTokens: row.maxTokens,
          reasoning: { efforts: row.efforts.map((id) => ({ id, name: id })), defaultEffort: row.defaultEffort },
        }
      },
      /** dsh-llm 的入口：Auto-Free 会把自己的裁决转发到这里。 */
      stream(options) {
        const index = calls.streams.length
        calls.streams.push(options)
        const plan =
          (script ? script(options, index) : null) ?? {
            chunks: [{ type: 'text', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }],
          }
        return (async function* () {
          if (plan.hang) await new Promise((resolve) => setTimeout(resolve, plan.hang))
          for (const chunk of plan.chunks ?? [{ type: 'finish', reason: { kind: 'stop' } }]) yield chunk
        })()
      },
    },
    effect,
    provide(key, value) {
      services.set(key, value)
    },
    get(key) {
      if (key === 'agentDefaultModel') return selection ? { currentSelection: () => selection } : undefined
      if (key === 'sessions') {
        return { subagentAddress: (id) => (subagents.includes(id) ? { kind: 'subagent' } : undefined) }
      }
      return undefined
    },
    inject(_deps, cb) {
      cb({ webServer: { register: (route) => (routes.push(route), () => {}) }, effect })
    },
  }

  // 真机语义：这个 profile 里**没有 fs 服务**，真 fiber 里 `ctx.fs` 会抛
  // `cannot get property "fs" without inject`——插件在 apply / 构造期读它就等于启动即崩。
  Object.defineProperty(ctx, 'fs', {
    configurable: true,
    get() {
      throw new Error('cannot get property "fs" without inject')
    },
  })
  ctx.reflect = { get: () => undefined }

  reset()
  plugin.apply(ctx, config)
  return {
    ctx,
    calls,
    routes,
    logs,
    disposes,
    services,
    adapter: () => {
      assert.ok(registered, 'the Auto-Free adapter must be registered')
      return registered.adapter
    },
    providers: () => registered?.providers,
  }
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

const failure = (code, message = code) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } })
const text = (value) => ({ type: 'text', text: value })
const stop = { type: 'finish', reason: { kind: 'stop' } }
const ask = (sessionId) => ({ provider: ROUTE, model: AUTO_MODEL, messages: [], sessionId })

// --- 1 ---------------------------------------------------------------------
{
  const world = makeCtx()
  assert.deepEqual(world.providers(), [ROUTE])
  const adapter = world.adapter()
  assert.deepEqual(adapter.providerInfo(ROUTE), { id: ROUTE, name: 'Auto-Free' })
  assert.deepEqual(adapter.providerRetryPolicy(), { maxRetries: 2, retryableCodes: ['SERVER'] })

  const rows = await adapter.listModels()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].provider, ROUTE)
  assert.equal(rows[0].id, AUTO_MODEL)
  assert.equal(rows[0].name, 'Auto-Free')
  assert.match(rows[0].description, /M Best/)
  assert.deepEqual(rows[0].inputModalities, ['text', 'image'])
  assert.equal(rows[0].context.contextWindow, 1_000_000, 'the top candidate own window')
  assert.equal(rows[0].defaultMaxTokens, 32_768)
  assert.deepEqual(
    rows[0].reasoning.efforts.map((effort) => effort.id),
    ['light', 'balanced', 'high', 'deep'],
    'the union ladder, ordered by rank',
  )
  assert.equal(rows[0].reasoning.defaultEffort, 'light', "the top candidate's own default")

  const prepared = await adapter.prepareCall(ROUTE, AUTO_MODEL)
  assert.equal(prepared.model.id, AUTO_MODEL)
  assert.equal(typeof prepared.stream, 'function')
  console.log('1  one advertised model, union ladder, metadata from the top candidate')
}

// --- 2 ---------------------------------------------------------------------
{
  const world = makeCtx()
  LIST = []
  reset()
  assert.deepEqual(await world.adapter().listModels(), [], 'no candidates: advertise nothing (no empty picker group)')
  const error = await collect(world.adapter().stream(ask('s0'))).then(
    () => null,
    (thrown) => thrown,
  )
  assert.ok(error, 'an empty pool must fail loudly')
  assert.equal(error.code, 'NO_FREE_MODEL')
  LIST = ['m-best', 'm-mid', 'm-slow', 'm-raw']
  reset()
  console.log('2  empty catalog: nothing advertised, NO_FREE_MODEL on a call')
}

// --- 3 ---------------------------------------------------------------------
{
  const world = makeCtx()
  const adapter = world.adapter()
  const chunks = await collect(adapter.stream(ask('s1')))
  assert.deepEqual(chunks, [text('ok'), stop], 'the terminal finish chunk is forwarded')
  assert.equal(world.calls.streams[0].provider, MAIN)
  assert.equal(world.calls.streams[0].model, 'm-best', 'the top of the list')
  assert.equal('reasoningEffort' in world.calls.streams[0], false, 'no explicit request: the target model keeps its own default')

  // 列表头变了（新模型首字更快、窗口更大）……
  LIST = ['m-new', 'm-best', 'm-mid', 'm-slow', 'm-raw']
  reset()
  await world.services.get('free-auto').refresh()
  const top = await adapter.listModels()
  assert.match(top[0].description, /M New/, 'the picker now advertises the new head')

  // ……同一个会话不跟着动，新会话才用新头。
  await collect(adapter.stream(ask('s1')))
  assert.equal(world.calls.streams[1].model, 'm-best', 'sticky: the same session keeps its model')
  await collect(adapter.stream(ask('s2')))
  assert.equal(world.calls.streams[2].model, 'm-new', 'a new session starts at the top')

  LIST = ['m-best', 'm-mid', 'm-slow', 'm-raw']
  reset()
  console.log('3  per-session stickiness even when the list head changes')
}

// --- 4 ---------------------------------------------------------------------
{
  const world = makeCtx({
    script: (_options, index) =>
      index === 0 ? { chunks: [failure('RATE_LIMIT', 'free lane is busy')] } : { chunks: [text('after'), stop] },
  })
  const adapter = world.adapter()
  const chunks = await collect(adapter.stream(ask('s1')))
  assert.deepEqual(chunks, [text('after'), stop], 'the failure chunk is swallowed, the session continues')
  assert.equal(world.calls.streams[0].model, 'm-best')
  assert.equal(world.calls.streams[1].model, 'm-mid', 'cooled and switched to the next usable model')
  assert.ok(world.calls.listModels >= 2, 'the list was re-walked after the failure')
  const status = adapter.status()
  assert.equal(status.ok, true)
  assert.equal(status.route, ROUTE)
  assert.equal(status.model, AUTO_MODEL)
  assert.ok(
    status.cooldowns.some((entry) => entry.key === `${MAIN}\u0000m-best`),
    'the walled model is cooling',
  )
  assert.equal(status.elections.find((entry) => entry.sessionId === 's1').model, 'm-mid')
  assert.ok(world.logs.some(([, line]) => /冷却/.test(line)))

  // 下一条消息直接用新选举，不再碰被限流的那个。
  assert.deepEqual(await collect(adapter.stream(ask('s1'))), [text('after'), stop])
  assert.equal(world.calls.streams[2].model, 'm-mid')
  console.log('4  RATE_LIMIT: transparent switch + fresh list + cooldown, same session continues')
}

// --- 5 ---------------------------------------------------------------------
{
  const world = makeCtx({
    script: (_options, index) => (index === 0 ? { chunks: [failure('QUOTA_EXCEEDED', 'quota used up')] } : { chunks: [text('ok'), stop] }),
  })
  assert.deepEqual(await collect(world.adapter().stream(ask('q1'))), [text('ok'), stop])
  assert.equal(world.calls.streams[1].model, 'm-mid', 'quota exhaustion also switches')

  const other = makeCtx({ script: () => ({ chunks: [failure('SERVER', 'boom')] }) })
  const passed = await collect(other.adapter().stream(ask('q2')))
  assert.equal(passed.length, 1)
  assert.equal(passed[0].reason.failure.code, 'SERVER', 'a non-switch code is passed through unchanged')
  assert.equal(other.calls.streams.length, 1, 'no silent model switch for an unrelated error')
  assert.equal(
    other.adapter().status().elections.find((entry) => entry.sessionId === 'q2').model,
    'm-best',
    'the election survives a transient error',
  )

  const aborted = makeCtx({ script: () => ({ chunks: [failure('ABORTED', 'user stopped it')] }) })
  const cancelled = await collect(aborted.adapter().stream(ask('q3')))
  assert.equal(cancelled[0].reason.failure.code, 'ABORTED')
  assert.equal(aborted.calls.streams.length, 1, 'a cancellation is not a routing signal')
  console.log('5  QUOTA switches; SERVER/ABORTED do not')
}

// --- 6 ---------------------------------------------------------------------
{
  const world = makeCtx({ script: () => ({ chunks: [text('partial'), failure('RATE_LIMIT')] }) })
  const chunks = await collect(world.adapter().stream(ask('p1')))
  assert.deepEqual(chunks, [text('partial'), failure('RATE_LIMIT')])
  assert.equal(world.calls.streams.length, 1, 'content already emitted: never re-route')
  console.log('6  content emitted: no re-route, the failure goes up')
}

// --- 7 ---------------------------------------------------------------------
{
  const world = makeCtx({ script: () => ({ chunks: [failure('RATE_LIMIT')] }) })
  const chunks = await collect(world.adapter().stream(ask('a1')))
  assert.equal(world.calls.streams.length, 3, 'maxAttempts = 3')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.failure.code, 'RATE_LIMIT')
  const tried = world.calls.streams.map((options) => options.model)
  assert.equal(new Set(tried).size, tried.length, 'never retries the same model twice')

  const bounded = makeCtx({ config: { retry: { maxAttempts: 2 } }, script: () => ({ chunks: [failure('RATE_LIMIT')] }) })
  await collect(bounded.adapter().stream(ask('a2')))
  assert.equal(bounded.calls.streams.length, 2, 'configurable ceiling')
  console.log('7  retry attempts are bounded and never repeat a model')
}

// --- 8 ---------------------------------------------------------------------
{
  const rows = [
    { provider: MAIN, model: 'best', state: 'available', ttftMs: 1000 },
    { provider: MAIN, model: 'mid', state: 'available', ttftMs: 2000 },
    { provider: MAIN, model: 'slow', state: 'available', ttftMs: 9000 },
    { provider: MAIN, model: 'raw', state: 'unknown' },
  ]
  assert.equal(plugin.chooseSubagentTarget(rows, {}, () => 0).model, 'mid', 'probed, non-best, within 5x')
  assert.equal(plugin.chooseSubagentTarget(rows, {}, () => 0.99).model, 'mid')
  const many = [...rows, { provider: MAIN, model: 'mid2', state: 'available', ttftMs: 3000 }]
  assert.equal(plugin.chooseSubagentTarget(many, {}, () => 0).model, 'mid')
  assert.equal(plugin.chooseSubagentTarget(many, {}, () => 0.99).model, 'mid2', 'random among eligible models')
  assert.equal(
    plugin.chooseSubagentTarget([{ provider: MAIN, model: 'best', state: 'available', ttftMs: 1000 }, rows[3]], {}, () => 0).model,
    'raw',
    'only one probed model: fall back to random among the unprobed',
  )
  assert.equal(
    plugin.chooseSubagentTarget([{ provider: MAIN, model: 'best', state: 'available', ttftMs: 1000 }], {}, () => 0).model,
    'best',
    'last resort: the best model',
  )
  assert.equal(plugin.chooseSubagentTarget([], {}, () => 0), null, 'no rows: nothing to choose')
  assert.equal(
    plugin.chooseSubagentTarget(
      [
        { provider: MAIN, model: 'best', state: 'available', ttftMs: 1000 },
        { provider: MAIN, model: 'far', state: 'available', ttftMs: 20_000 },
        { provider: MAIN, model: 'raw', state: 'unknown' },
      ],
      {},
      () => 0,
    ).model,
    'raw',
    'slower than 5x is not eligible',
  )

  // 适配器里：子智能体会话走避让规则（不是列表头）。
  const world = makeCtx({ subagents: ['sub-1'] })
  await collect(world.adapter().stream(ask('sub-1')))
  assert.notEqual(world.calls.streams[0].model, 'm-best', 'a subagent avoids the best model')
  assert.ok(['m-mid', 'm-slow'].includes(world.calls.streams[0].model))
  await collect(world.adapter().stream(ask('sub-1')))
  assert.equal(world.calls.streams[1].model, world.calls.streams[0].model, 'a subagent session is sticky too')

  // 失败之后仍在避让规则里挑，而不是退回列表头。
  const retry = makeCtx({
    subagents: ['sub-2'],
    script: (_options, index) => (index === 0 ? { chunks: [failure('RATE_LIMIT')] } : { chunks: [text('ok'), stop] }),
  })
  await collect(retry.adapter().stream(ask('sub-2')))
  assert.notEqual(retry.calls.streams[1].model, 'm-best', 'a subagent never falls back onto the best model')

  const greedy = makeCtx({ config: { subagent: { avoidBest: false } }, subagents: ['sub-3'] })
  await collect(greedy.adapter().stream(ask('sub-3')))
  assert.equal(greedy.calls.streams[0].model, 'm-best', 'avoidBest: false gives subagents the top model')
  console.log('8  subagent rule: avoid the best model, sticky, bounded by 5x TTFT')
}

// --- 9 ---------------------------------------------------------------------
{
  const world = makeCtx()
  // 先让 apply() 里那次预热走完，再改文件、再强制重扫，才谈得上确定。
  await world.services.get('free-auto').refresh()
  writeAvailability({
    'm-best': { state: 'throttled', detail: '限流', latencyMs: 1200, ttftMs: 1000, at: at() },
    'm-mid': probed(2000),
    'm-slow': probed(9000),
    'm-raw': raw(),
  })
  await world.services.get('free-auto').refresh()
  await collect(world.adapter().stream(ask('c1')))
  assert.equal(world.calls.streams[0].model, 'm-mid', 'a throttled model never tops the usable list')
  const snapshot = world.services.get('free-auto').models()
  assert.ok(snapshot.hiddenModels.some((row) => row.model === 'm-best'))
  console.log('9  unusable models are excluded from the list (and folded)')
}

// --- 10 --------------------------------------------------------------------
{
  const world = makeCtx({
    config: { retry: { firstChunkTimeoutMs: 80 } },
    script: (_options, index) => (index === 0 ? { hang: 400, chunks: [text('late'), stop] } : { chunks: [text('fast'), stop] }),
  })
  const chunks = await collect(world.adapter().stream(ask('h1')))
  assert.deepEqual(chunks, [text('fast'), stop], 'a stalling model is abandoned for the next one')
  assert.equal(world.calls.streams[0].model, 'm-best')
  assert.equal(world.calls.streams[1].model, 'm-mid')
  assert.ok(!chunks.some((chunk) => chunk.reason?.failure), 'the caller never sees the timeout')
  console.log('10 first-chunk watchdog switches models instead of hanging')
}

// --- 11 --------------------------------------------------------------------
{
  const world = makeCtx({ script: (options) => ({ chunks: [text(String(options.reasoningEffort ?? 'none')), stop] }) })
  const adapter = world.adapter()
  assert.deepEqual(await collect(adapter.stream({ ...ask('e1'), reasoningEffort: 'deep' })), [text('deep'), stop])
  assert.equal(world.calls.streams[0].reasoningEffort, 'deep', 'm-best really declares deep')
  assert.deepEqual(await collect(adapter.stream({ ...ask('e1'), reasoningEffort: 'off' })), [text('none'), stop])
  assert.equal('reasoningEffort' in world.calls.streams[1], false, 'an off rung is dropped, not passed through')

  // 目标模型没有 deep（m-mid 的阶梯是 light/balanced）→ 按排名降到 balanced。
  const projected = makeCtx({ script: (options) => ({ chunks: [text(String(options.reasoningEffort ?? 'none')), stop] }) })
  await projected.services.get('free-auto').refresh()
  writeAvailability({ 'm-mid': probed(2000), 'm-raw': raw() })
  await projected.services.get('free-auto').refresh()
  assert.deepEqual(await collect(projected.adapter().stream({ ...ask('e2'), reasoningEffort: 'deep' })), [text('balanced'), stop])
  assert.equal(projected.calls.streams[0].model, 'm-mid')
  console.log('11 effort projection keeps a requested rung legal')
}

// --- 12 --------------------------------------------------------------------
{
  const world = makeCtx()
  await world.services.get('free-auto').refresh()
  const status = world.services.get('free-auto').status()
  assert.equal(status.route, ROUTE)
  const snapshot = world.services.get('free-auto').models()
  assert.equal(snapshot.models[0].model, 'm-best')
  assert.equal('auto' in snapshot, false, 'the plain inspection handle has no per-session election')

  const res = {
    status: 0,
    headers: null,
    writeHead(code, headers) {
      this.status = code
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
  const models = world.routes.find((route) => route.path === '/api/free-auto/models')
  await models.handler({ method: 'GET', url: '/api/free-auto/models?sessionId=s1' }, res)
  const json = JSON.parse(res.body)
  assert.equal(json.auto.available, true)
  assert.equal('elected' in json.auto, false, 'no election for that session')

  await collect(world.adapter().stream(ask('s1')))
  await models.handler({ method: 'GET', url: '/api/free-auto/models?sessionId=s1' }, res)
  const elected = JSON.parse(res.body)
  assert.equal(elected.auto.elected.model, 'm-best', 'the payload reports the session election')
  assert.equal(elected.auto.elected.name, 'M Best')

  const refresh = world.routes.find((route) => route.path === '/api/free-auto/refresh')
  assert.ok(refresh, 'the refresh route exists for the client')
  console.log('12 the HTTP payload advertises the Auto-Free row and the election')
}

// --- 13 --------------------------------------------------------------------
{
  // README 的既有承诺：Auto-Free = 列表第一名。改序之后这条必须继续成立。
  // 限定词很重要：只对**尚未选举过**的会话成立——已选举的会话按既有承诺锁定旧模型
  // （会话内锁定在 §3 里单独守着）。
  // 宿主半身按真实请求流读体（for await），所以这里给一个异步可迭代对象。
  const send = (route, method, body, url = '/api/free-auto/models') => {
    const res = { status: 0, headers: null, body: undefined, writeHead(code, headers) { this.status = code; this.headers = headers }, end(chunk) { this.body = chunk } }
    const req = {
      method,
      url,
      async *[Symbol.asyncIterator]() {
        if (body) yield body
      },
    }
    return route.handler(req, res).then(() => res)
  }
  const fields = (keys) => keys.map((key) => ({ key, enabled: true }))

  // 本样本里 m-best 在每个字段上都赢（可用性/多模态/首字/上下文/输出上限全都第一），
  // 光换顺序不可能换头。所以这里把目录里本来就有的 m-new（视觉 + 2M 上下文 +
  // 65536 输出上限，但首字慢一点）也放进列表，它才让"改序换头"变得可观察。
  LIST = ['m-best', 'm-mid', 'm-slow', 'm-raw', 'm-new']
  const world = makeCtx()
  const free = world.services.get('free-auto')
  await free.refresh()
  // m-new 首字 3000ms：默认链（多模态 → 首字）下 m-best(1000ms) 仍然第一。
  writeAvailability({ 'm-best': probed(1000), 'm-mid': probed(2000), 'm-slow': probed(9000), 'm-new': probed(3000), 'm-raw': raw() })
  await free.refresh()
  const before = free.models()
  assert.deepEqual(
    before.models.map((row) => row.model),
    ['m-best', 'm-new', 'm-mid', 'm-slow', 'm-raw'],
    'default chain: vision first, then the fastest first token',
  )
  assert.equal(before.models[0].model, 'm-best')

  const settings = world.routes.find((route) => route.path === '/api/free-auto/settings')
  assert.ok(settings, 'the settings route is registered next to the others')
  const models = world.routes.find((route) => route.path === '/api/free-auto/models')

  // 「输出上限」提到最前：m-new 的 65536 顶上来，第一名从 m-best 换成 m-new。
  const posted = await send(settings, 'POST', JSON.stringify({ fields: fields(['maxTokens', 'availability', 'multimodal', 'ttft', 'context']) }))
  assert.equal(posted.status, 200)
  const swapped = free.models()
  assert.deepEqual(
    swapped.models.map((row) => row.model),
    ['m-new', 'm-best', 'm-mid', 'm-slow', 'm-raw'],
    'maxTokens-first really re-orders the list',
  )
  assert.deepEqual(swapped.models.map((row) => row.model), JSON.parse(posted.body).models.map((row) => row.model), 'POST and the live list agree')
  assert.equal(swapped.models[0].model, 'm-new', 'the new head is the model with the largest output ceiling')
  await collect(world.adapter().stream(ask('s-elec')))
  assert.equal(
    world.calls.streams[0].model,
    swapped.models[0].model,
    'after re-ordering, Auto-Free still elects the new list head',
  )
  assert.notEqual(swapped.models[0].model, before.models[0].model, 'the new head really differs from the old one')
  const payload = await send(models, 'GET', undefined, '/api/free-auto/models?sessionId=s-elec')
  assert.equal(JSON.parse(payload.body).auto.elected.model, swapped.models[0].model, 'and the HTTP payload says so too')

  // 停用一个字段必须真的把它踢出比较（而不是只把它挪个位置）：同一组顺序里
  // maxTokens 领跑时 head 是 m-new；把它停掉，head 必须换回 m-best。
  const off = fields(['maxTokens', 'availability', 'multimodal', 'ttft', 'context']).map((field) =>
    field.key === 'maxTokens' ? { ...field, enabled: false } : field,
  )
  const disabled = await send(settings, 'POST', JSON.stringify({ fields: off }))
  assert.equal(disabled.status, 200)
  const retired = free.models()
  assert.equal(
    retired.models[0].model,
    'm-best',
    'disabling the leading field hands the head back (ignoring `enabled` would keep m-new first)',
  )
  assert.deepEqual(
    retired.models.map((row) => row.model),
    before.models.map((row) => row.model),
    'and the list it produces equals the default-chain list',
  )
  assert.deepEqual(
    JSON.parse(disabled.body).sortFields.map((field) => [field.key, field.enabled]),
    [['maxTokens', false], ['availability', true], ['multimodal', true], ['ttft', true], ['context', true]],
    'the disabled flag survives the round trip',
  )

  // {reset:true} 之后第一名回到改动前那一个。
  const reset = await send(settings, 'POST', JSON.stringify({ reset: true }))
  assert.equal(reset.status, 200)
  await collect(world.adapter().stream(ask('s-reset')))
  assert.equal(world.calls.streams[1].model, 'm-best', 'reset puts the original winner back on top')
  assert.deepEqual(
    free.models().models.map((row) => row.model),
    before.models.map((row) => row.model),
    'reset reproduces the pre-settings list row for row',
  )
  LIST = ['m-best', 'm-mid', 'm-slow', 'm-raw']
  console.log('13 for a session that has not elected yet, the elected model always equals the top of the list, before and after re-ordering')
}

console.log('dsh-free-auto: all router assertions passed')