/**
 * Offline smoke test for dsh-free-auto (model switcher).
 *
 *   node test/smoke.mjs
 *
 * No DSH runtime and no network: ctx.llm is a fake catalog, the webServer is a
 * fake registrar, and the HTTP handler is invoked directly. Guards the contract
 * the client half and the DSH session UI depend on.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as plugin from '../index.js'
import { SORT_FIELDS, normalizeFields } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * A controlled DSH_HOME: the host half reads availability verdicts and measured
 * stats from <DSH_HOME>/our-free-model/, and the real files must not leak into
 * the assertions.
 */
const DSH_HOME = mkdtempSync(join(tmpdir(), 'free-auto-smoke-'))
process.env.DSH_HOME = DSH_HOME

/** 跑完（含断言失败退出）都回收临时 HOME，别在 %TEMP% 里堆 free-auto-smoke-*。 */
process.on('exit', () => rmSync(DSH_HOME, { recursive: true, force: true }))

function childFile(name, value) {
  mkdirSync(join(DSH_HOME, 'our-free-model'), { recursive: true })
  writeFileSync(join(DSH_HOME, 'our-free-model', name), JSON.stringify(value))
}

function writeAvailability(results) {
  childFile('availability.json', { version: 1, at: Date.now(), egress: null, results })
}

/** stats.json: per-day measured totals; the host half sums the days. */
function writeStats(models) {
  childFile('stats.json', { version: 3, days: { '2026-10-09': { models } } })
}

const CATALOG = {
  'our-free-model': [
    { id: 'text-128k', name: 'Text 128K', inputModalities: ['text'] },
    { id: 'vision-1m', name: 'Vision 1M', inputModalities: ['text', 'image'] },
    { id: 'tiny', name: 'Tiny 32K', inputModalities: ['text'] },
    { id: 'text-128k-big', name: 'Text 128K Big', inputModalities: ['text'] },
    { id: 'text-2m', name: 'Text 2M', inputModalities: ['text'] },
  ],
  'our-free-model-region': [{ id: 'region-200k', name: 'Region 200K', inputModalities: ['text'] }],
}

const DETAILS = {
  'our-free-model\u0000vision-1m': {
    inputModalities: ['text', 'image'],
    context: { contextWindow: 1_048_576 },
    defaultMaxTokens: 8_192,
    reasoning: { efforts: [{ id: 'light', name: 'Light' }, { id: 'deep', name: 'Deep' }], defaultEffort: 'light' },
  },
  'our-free-model\u0000text-2m': {
    inputModalities: ['text'],
    context: { contextWindow: 2_097_152 },
    defaultMaxTokens: 4_096,
  },
  'our-free-model\u0000text-128k': {
    inputModalities: ['text'],
    context: { contextWindow: 131_072 },
    defaultMaxTokens: 16_384,
  },
  'our-free-model\u0000text-128k-big': {
    inputModalities: ['text'],
    context: { contextWindow: 131_072 },
    defaultMaxTokens: 32_768,
  },
  'our-free-model\u0000tiny': {
    inputModalities: ['text'],
    context: { contextWindow: 32_768 },
    defaultMaxTokens: 4_096,
    reasoning: { efforts: [] },
  },
  'our-free-model-region\u0000region-200k': {
    inputModalities: ['text'],
    context: { contextWindow: 204_800 },
    defaultMaxTokens: 8_192,
    reasoning: { efforts: [{ id: 'light', name: 'Light' }, { id: 'max', name: 'Max' }] },
  },
}

const MODELS_PATH = '/api/free-auto/models'
const REFRESH_PATH = '/api/free-auto/refresh'
const SETTINGS_PATH = '/api/free-auto/settings'
const REPROBE_URL = '/api/our-free-model/reprobe'
/** `<DSH_HOME>/free-auto/settings.json`：插件自己写排序链的地方。 */
const SETTINGS_FILE = join(DSH_HOME, 'free-auto', 'settings.json')
const AVAILABILITY_FILE = join(DSH_HOME, 'our-free-model', 'availability.json')
const STATS_FILE = join(DSH_HOME, 'our-free-model', 'stats.json')
/** 清掉探测结果：让后面几节从"什么都不知道"的干净状态开始。 */
const clearProbe = () => {
  rmSync(AVAILABILITY_FILE, { force: true })
  rmSync(STATS_FILE, { force: true })
}
const clearSettings = () => rmSync(SETTINGS_FILE, { force: true })
/** 这里直接调导出的归一化，避免测试里再抄一份 5 字段表。 */
const perm = (...keys) => normalizeFields(keys.map((key) => ({ key })))
const order = (...keys) => keys.map((key) => ({ key, enabled: true }))

function makeCtx({ catalog = CATALOG, selection, modelWithoutDetail, requireFailure, fs, hold } = {}) {
  const calls = { listModels: 0, listProviders: 0 }
  const routes = []
  const logs = []
  const disposes = []
  const services = new Map()
  let registered = undefined

  const effect = (cb, _label) => {
    const dispose = cb()
    if (typeof dispose === 'function') disposes.push(dispose)
    return dispose
  }

  /** 模拟 `mkdirSync` 被拒（只读盘 / 权限）：用来验证写失败会变成 GET/POST 能看见的错误。 */
  const throwIfRequired = (path) => {
    if (requireFailure && String(path).startsWith(requireFailure)) {
      throw Object.assign(new Error(`EACCES: permission denied, mkdir '${path}'`), { code: 'EACCES' })
    }
  }

  // 宿主半身现在读写都走同一个 fs 抽象，所以这个假 fs 必须给全四个方法。
  const nodeFs = {
    mkdirSync(path, options) {
      throwIfRequired(path)
      return mkdirSync(path, options)
    },
    writeFileSync(path, data, options) {
      throwIfRequired(path)
      return writeFileSync(path, data, options)
    },
    existsSync(path) {
      return existsSync(path)
    },
    readFileSync(path, options) {
      return readFileSync(path, options)
    },
  }

  const ctx = {
    logger: {
      info: (text) => logs.push(['info', text]),
      warn: (text) => logs.push(['warn', text]),
    },
    llm: {
      registerAdapter(providers, adapter) {
        registered = { providers, adapter }
        return Object.assign(() => {}, { replace: () => {} })
      },
      async listProviders() {
        calls.listProviders += 1
        return Object.keys(catalog).map((id) => ({ id, name: id }))
      },
      async listModels(provider) {
        calls.listModels += 1
        if (!(provider in catalog)) {
          throw Object.assign(new Error(`unknown provider: ${provider}`), { code: 'PROVIDER_NOT_FOUND' })
        }
        // 让某条线路的目录读取挂住：用来制造"走列表期间设置变了"的竞态。
        if (hold && hold.provider === provider) await hold.wait
        return catalog[provider]
      },
      async resolveModelInfo(provider, model) {
        const key = `${provider}\u0000${model}`
        if (modelWithoutDetail === key) throw new Error('detail lookup failed')
        return DETAILS[key] ?? {}
      },
    },
    effect,
    provide(key, value) {
      services.set(key, value)
    },
    get(key) {
      if (key === 'agentDefaultModel' && selection) return { currentSelection: () => selection }
      return undefined
    },
    inject(_deps, cb) {
      cb({
        webServer: {
          register(route) {
            routes.push(route)
            return () => {}
          },
        },
        effect,
      })
    },
  }

  // 真机语义（cordis）：没注入的服务用属性访问就会抛
  // `cannot get property "fs" without inject` —— 本 profile 里也确实没有 fs 服务。
  // 夹具因此**永远**让 `ctx.fs` 抛：提供 fs 服务时只经 `ctx.reflect.get('fs')` 暴露
  // （真机上 fs 由别的 fiber 提供，同样拿不到属性访问）。谁在构造期读 ctx.fs，所有测试当场炸。
  // `fs: null` = 连服务都没有（真机现状）；缺省 = 用下面这个带 requireFailure 的 node:fs 桩。
  const providedFs = fs === undefined ? nodeFs : fs
  Object.defineProperty(ctx, 'fs', {
    configurable: true,
    get() {
      throw new Error('cannot get property "fs" without inject')
    },
  })
  ctx.reflect = { get: (key) => (key === 'fs' ? providedFs ?? undefined : undefined) }

  return { ctx, calls, routes, logs, disposes, services, registered: () => registered }
}

function start(config = {}, options = {}) {
  const world = makeCtx(options)
  plugin.apply(world.ctx, config)
  return world
}

async function request(world, { method = 'GET', path, body } = {}) {
  const route = path ? world.routes.find((entry) => entry.path === path) : world.routes[0]
  assert.ok(route, `the route ${path ?? MODELS_PATH} must be registered`)
  const res = {
    status: 0,
    headers: null,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
  await route.handler({ method, url: path ?? MODELS_PATH, async *[Symbol.asyncIterator]() {
    if (body !== undefined) yield Buffer.from(body)
  } }, res)
  const type = String(res.headers?.['content-type'] ?? '')
  const json = type.startsWith('application/json') && res.body ? JSON.parse(res.body) : undefined
  return { res, json }
}

// --- 1 ---------------------------------------------------------------------
{
  const world = start()
  assert.equal(plugin.name, 'free-auto')
  assert.ok(plugin.inject.includes('llm'))
  const registration = world.registered()
  assert.ok(registration, 'the Auto-Free provider route must be registered')
  assert.deepEqual(registration.providers, ['free-auto'], 'the virtual route the picker offers')
  assert.deepEqual(
    world.routes.map((route) => route.path),
    [MODELS_PATH, REFRESH_PATH, SETTINGS_PATH],
    'a read route, a cached-walk refresh route, and the sort-settings route',
  )
  assert.ok(world.routes.every((route) => route.kind === 'exact'))
  assert.ok(world.services.has('free-auto'), 'the plugin provides an inspection handle')
  console.log('1  the Auto-Free adapter route; read + refresh + settings routes, all exact')
}

// --- 2 ---------------------------------------------------------------------
{
  const world = start()
  const { res, json } = await request(world)
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(json.ok, true)
  assert.deepEqual(
    json.models.map((row) => row.model),
    ['vision-1m', 'text-2m', 'text-128k-big', 'text-128k', 'tiny'],
    'vision first, then longer context, then larger output ceiling',
  )
  assert.deepEqual(
    json.models.map((row) => row.rank),
    [1, 2, 3, 4, 5],
  )
  assert.deepEqual(
    json.hideStates,
    ['unavailable', 'throttled', 'region-blocked'],
    'unusable states are folded by default',
  )
  assert.deepEqual(
    json.hiddenModels.map((row) => row.model),
    ['region-200k'],
    'the region lane is folded, never dropped',
  )
  assert.equal(json.hiddenModels[0].state, 'region-blocked')
  assert.ok(
    json.models.every((row) => row.state === 'unknown'),
    'no probe file yet: main-lane rows are merely unprobed, and the region lane is folded',
  )
  assert.ok(json.models.every((row) => row.provider !== 'free-auto'), 'no pseudo-provider rows')
  const vision = json.models[0]
  assert.equal(vision.vision, true)
  assert.equal(vision.contextWindow, 1_048_576)
  assert.equal(vision.maxTokens, 8_192)
  assert.equal(vision.ttftMs, null, 'nothing measured yet')
  assert.equal(vision.ttftSource, '')
  assert.deepEqual(vision.reasoning.efforts.map((e) => e.id), ['light', 'deep'])
  assert.equal(vision.reasoning.defaultEffort, 'light')
  assert.deepEqual(json.sources, ['our-free-model', 'our-free-model-region'])
  console.log('2  ranked list: vision > context > output, with metadata, ranks and folded rows')
}

// --- 3 ---------------------------------------------------------------------
{
  const world = start({ candidateTtlMs: 10_000 })
  await request(world)
  const walked = world.calls.listModels
  await request(world)
  assert.equal(world.calls.listModels, walked, 'a warm list is reused inside the TTL')
  const snapshot = world.services.get('free-auto').models()
  assert.equal(snapshot.models.length, 5)
  assert.equal(snapshot.models[0].model, 'vision-1m')
  await world.services.get('free-auto').refresh()
  assert.ok(world.calls.listModels > walked, 'refresh() re-walks the catalog')

  const eager = start({ candidateTtlMs: 0 })
  await request(eager)
  const first = eager.calls.listModels
  await request(eager)
  assert.ok(eager.calls.listModels > first, 'candidateTtlMs 0 disables reuse')
  console.log('3  TTL cache, synchronous snapshot, explicit refresh')
}

// --- 4 ---------------------------------------------------------------------
{
  const world = start({ sourceRoutes: ['nope', 'our-free-model'] })
  const { json } = await request(world)
  assert.deepEqual(
    json.models.map((row) => row.model),
    ['vision-1m', 'text-2m', 'text-128k-big', 'text-128k', 'tiny'],
    'an unknown route contributes nothing instead of failing',
  )

  const empty = start({ sourceRoutes: ['nope'] })
  const { res, json: none } = await request(empty)
  assert.equal(res.status, 200)
  assert.equal(none.ok, true)
  assert.deepEqual(none.models, [], 'all sources missing is an empty list, not an error')
  assert.deepEqual(none.hiddenModels, [])

  const broken = start({ sourceRoutes: ['our-free-model', 'our-free-model-region'] }, {
    modelWithoutDetail: 'our-free-model\u0000vision-1m',
  })
  const { json: fallback } = await request(broken)
  assert.equal(fallback.models[0].model, 'vision-1m', 'a failed detail call keeps the listModels row')
  assert.equal(fallback.models[0].contextWindow, null)
  assert.equal(fallback.models[0].maxTokens, null)
  console.log('4  missing route / empty catalog / failed detail lookup')
}

// --- 5 ---------------------------------------------------------------------
{
  const world = start()
  const post = await request(world, { method: 'POST' })
  assert.equal(post.res.status, 405)
  const head = await request(world, { method: 'HEAD' })
  assert.equal(head.res.status, 200)
  assert.equal(head.res.body, undefined, 'HEAD sends headers only')

  const get = await request(world, { path: REFRESH_PATH, method: 'GET' })
  assert.equal(get.res.status, 405, 'the refresh route is POST-only')
  assert.equal(get.res.body, 'method not allowed')
  const bumped = await request(world, { path: REFRESH_PATH, method: 'POST' })
  assert.equal(bumped.res.status, 200)
  assert.equal(bumped.json.ok, true)
  assert.ok(bumped.json.updatedAt > 0, 'a forced walk re-stamps the snapshot')
  console.log('5  GET/HEAD on the read route, POST on the refresh route, 405 otherwise')
}

// --- 6 ---------------------------------------------------------------------
{
  const world = start({}, { selection: { provider: 'our-free-model', model: 'text-128k', reasoningEffort: 'light' } })
  const { json } = await request(world)
  assert.deepEqual(json.current, {
    provider: 'our-free-model',
    model: 'text-128k',
    reasoningEffort: 'light',
  })

  const anonymous = start()
  const { json: none } = await request(anonymous)
  assert.equal(none.current, null, 'no agentDefaultModel service → null, never a throw')

  const effortless = start({}, { selection: { provider: 'our-free-model', model: 'tiny' } })
  const { json: bare } = await request(effortless)
  assert.equal('reasoningEffort' in bare.current, false)
  console.log('6  current selection reported (and null when unavailable)')
}

// --- 7 ---------------------------------------------------------------------
{
  const world = start({ includeAllProviders: true, hideStates: [] })
  await request(world)
  assert.ok(world.calls.listProviders > 0, 'includeAllProviders reads listProviders')
  const { json } = await request(world)
  assert.equal(json.models.length, 6, 'hideStates: [] lists the region lane again')
  const tiny = json.models.find((row) => row.model === 'tiny')
  assert.deepEqual(tiny.reasoning.efforts, [])
  assert.equal(tiny.reasoning.defaultEffort, null)
  const region = json.models.find((row) => row.model === 'region-200k')
  assert.equal(region.reasoning.defaultEffort, 'light', 'no declared default → first rung')
  console.log('7  includeAllProviders; missing effort ladders degrade cleanly')
}

// --- 8 ---------------------------------------------------------------------
{
  const client = readFileSync(join(here, '..', 'client.js'), 'utf8')
  assert.ok(client.includes(MODELS_PATH), 'the widget reads the ranked list route')
  assert.equal(client.includes('/api/free-auto/events'), false, 'no SSE endpoint is used any more')
  assert.equal(
    client.includes('conversation.composer.dock'),
    false,
    'the old composer-dock badge is gone',
  )
  assert.match(client, /position:\s*fixed|position:fixed/, 'the widget floats over the session page')
  assert.ok(client.includes("'pointerdown'"), 'clicking outside the panel closes it')
  assert.ok(client.includes("'Escape'"), 'Esc closes the list')
  assert.ok(client.includes('LEAVE_CLOSE_MS'), 'the list auto-closes after the pointer leaves')
  assert.ok(client.includes('onMouseLeave'), 'mouse leaving the widget is observed')
  assert.ok(client.includes('STATE_LABELS'), 'list rows are labelled with the availability state')
  assert.ok(client.includes('fa-row-dim'), 'models that are not available are dimmed')
  assert.ok(client.includes('hiddenModels'), 'the folded group is rendered from hiddenModels')
  assert.ok(client.includes('fa-more'), 'the folded group sits behind an expander')
  assert.ok(client.includes(REPROBE_URL), 'the re-probe button calls the child plugin')
  assert.ok(client.includes('REFRESH_URL'), 'a forced walk backs the re-probe button')
  assert.ok(client.includes('formatAgo'), 'the row shows how long ago the probe ran')
  assert.ok(client.includes('ttftMs'), 'the row shows the first-token latency')
  assert.ok(client.includes('snapshot?.auto') || client.includes('snapshot.auto'), 'the Auto-Free row comes from the payload')
  assert.ok(client.includes('Auto-Free'), 'the first row is named Auto-Free')
  assert.ok(client.includes('fa-row-auto'), 'and it is styled as the special first row')
  assert.ok(client.includes('selectModel'), 'clicking a row switches the session model')
  // 「设置」按钮必须排在「重新探测」右边（DOM 顺序 = 源码里出现的先后）。
  assert.ok(client.includes(SETTINGS_PATH), 'the widget reads and writes the sort-settings route')
  assert.ok(client.includes('fa-settings'), 'the settings button is styled and greppable')
  assert.ok(client.includes('fa-set-check'), 'every sort field row has an enable checkbox')
  assert.ok(client.includes('fa-set-move'), 'every sort field row has up/down buttons')
  assert.equal(client.includes('onSubmit'), false, 'the panel stays on plain h(...) elements')
  const reprobeAt = client.indexOf("className: 'fa-refresh',")
  assert.ok(reprobeAt > 0, 'the re-probe button keeps its className')
  const settingsAt = client.indexOf("className: 'fa-refresh fa-settings',")
  assert.ok(settingsAt > 0, 'the settings button sits in the same header')
  assert.ok(settingsAt > reprobeAt, 'the settings button comes after the re-probe button')
  assert.equal(
    client.slice(reprobeAt, settingsAt).includes('reprobe('),
    true,
    'the re-probe button still owns the re-probe handler',
  )
  assert.ok(
    client.includes("'重新探测'") && client.includes("'探测中…'"),
    'the re-probe button copy is unchanged',
  )
  assert.ok(client.includes('POST') && /reset:\s*true/.test(client), 'one click restores the default chain')
  assert.ok(client.includes('sortChainText'), 'the footer is derived from the live sort chain')
  assert.equal(
    client.includes('按 可用 › 多模态 › 首字延迟 › 上下文 › 输出上限 排序'),
    false,
    'the footer no longer hard-codes the default chain',
  )
  console.log('8  client half: floating panel, folded group, re-probe, settings, no dock badge, no SSE')
}

// --- 9 ---------------------------------------------------------------------
{
  writeAvailability({
    'vision-1m': { state: 'available' },
    'text-2m': { state: 'available' },
    'tiny': { state: 'throttled' },
    'text-128k': { state: 'region-blocked' },
    'text-128k-big': { state: 'unavailable' },
  })
  const world = start()
  await world.services.get('free-auto').refresh()
  const { json } = await request(world)
  assert.deepEqual(
    json.models.map((row) => row.model),
    ['vision-1m', 'text-2m'],
    'only models the probe calls available survive the default hideStates',
  )
  assert.ok(json.models.every((row) => row.state === 'available'))
  assert.deepEqual(
    json.hiddenModels.map((row) => row.model),
    ['tiny', 'region-200k', 'text-128k', 'text-128k-big'],
    'folded rows keep the state order: throttled, region-blocked, unavailable',
  )

  const shown = start({ hideStates: [] })
  await shown.services.get('free-auto').refresh()
  const { json: all } = await request(shown)
  assert.deepEqual(
    all.models.map((row) => row.model),
    ['vision-1m', 'text-2m', 'tiny', 'region-200k', 'text-128k', 'text-128k-big'],
    'hideStates: [] keeps everything: available, unprobed, region-blocked, throttled, unavailable',
  )
  assert.deepEqual(all.hiddenModels, [], 'nothing is folded when hideStates is empty')
  assert.equal(
    all.models.find((row) => row.model === 'region-200k').state,
    'region-blocked',
    'the region lane counts as region-blocked even without a verdict of its own',
  )
  console.log('9  availability: unusable models are folded, usable ones rank first')
}

// --- 10 --------------------------------------------------------------------
{
  writeAvailability({
    'vision-1m': { state: 'available', ttftMs: 9_000, latencyMs: 11_000, at: Date.now() - 120_000 },
    'text-128k': { state: 'available', ttftMs: 500, latencyMs: 900, at: Date.now() - 60_000 },
    'text-2m': { state: 'available', ttftMs: 8_000, latencyMs: 9_500, at: Date.now() - 300_000 },
    'tiny': { state: 'unavailable', detail: 'Model tiny has been deprecated.', at: Date.now() - 3 * 86_400_000 },
  })
  writeStats({
    // A measured average that differs from the single probe sample above.
    'text-128k': { ttftMs: 400, ttftSamples: 1, decodeMs: 10_000, decodeTokens: 2_000, calls: 2, failed: 0 },
    // No TTFT samples at all: the probe value has to stand in.
    'text-2m': { ttftMs: 0, ttftSamples: 0, decodeMs: 20_000, decodeTokens: 1_000, calls: 4, failed: 1 },
  })
  const world = start()
  await world.services.get('free-auto').refresh()
  const { json } = await request(world)
  assert.deepEqual(
    json.models.map((row) => row.model),
    ['vision-1m', 'text-128k', 'text-2m', 'text-128k-big'],
    'multimodal outranks latency, latency outranks context, unmeasured rows come last',
  )
  const measured = json.models.find((row) => row.model === 'text-128k')
  assert.equal(measured.ttftMs, 400, 'the measured average wins over a single probe sample')
  assert.equal(measured.ttftSource, 'stats')
  assert.equal(measured.probeTtftMs, 500, 'the probe value is still reported')
  assert.ok(measured.probedAt > 0, 'the probe time is carried for display')
  assert.equal(measured.tps, 200, 'decode speed = decodeTokens / decodeMs')
  const probed = json.models.find((row) => row.model === 'text-2m')
  assert.equal(probed.ttftMs, 8_000, 'without samples the probe value is the sort key')
  assert.equal(probed.ttftSource, 'probe')
  assert.equal(probed.avgTtftMs, null)
  assert.equal(probed.tps, 50)
  assert.equal(probed.calls, 4)
  assert.equal(probed.failed, 1)
  const folded = json.hiddenModels.find((row) => row.model === 'tiny')
  assert.equal(folded.state, 'unavailable')
  assert.equal(folded.detail, 'Model tiny has been deprecated.', 'the reason is available for the folded row')
  assert.ok(folded.probedAt > 0)
  const unmeasured = json.models.find((row) => row.model === 'text-128k-big')
  assert.equal(unmeasured.ttftMs, null)
  assert.equal(unmeasured.state, 'unknown')
  console.log('10 latency ranking, measured stats, folded reasons')
}

// --- 11 --------------------------------------------------------------------
{
  // 设置文件：先清掉，保证这一节从"没写过设置"开始（默认链）。
  rmSync(SETTINGS_FILE, { force: true })
  // 第 9/10 节的 availability/stats 还在：可见顺序 = vision-1m > text-128k > text-2m > text-128k-big。
  const world = start()
  const { json: base } = await request(world)
  const baseOrder = base.models.map((row) => row.model)
  assert.deepEqual(baseOrder, ['vision-1m', 'text-128k', 'text-2m', 'text-128k-big'], 'the pre-settings default chain')
  assert.deepEqual(
    base.sortFields.map((field) => field.key),
    ['availability', 'multimodal', 'ttft', 'context', 'maxTokens'],
    'the payload reports the chain in effect',
  )
  assert.ok(base.sortFields.every((field) => field.enabled === true), 'all five fields are on by default')

  // 1) 改序：把「输出上限」提到最前（可用性仍在链里，但第一把交椅换了人）。
  const moved = order('maxTokens', 'availability', 'context', 'multimodal', 'ttft')
  const custom = start()
  await custom.services.get('free-auto').saveSortFields(moved)
  const { json: reordered } = await request(custom)
  assert.deepEqual(
    reordered.models.map((row) => row.model),
    ['text-128k-big', 'text-128k', 'vision-1m', 'text-2m'],
    'maxTokens first: the biggest output ceiling leads (was 4th)',
  )
  assert.notDeepEqual(reordered.models.map((row) => row.model), baseOrder, 'the order really changed')

  // 2) 停用「多模态」：纯文本与视觉不再分层，只剩可用性 + 延迟等其余字段。
  const noVision = perm('availability', 'ttft', 'context', 'maxTokens').map(({ key }) => ({
    key,
    enabled: key !== 'multimodal',
  }))
  await custom.services.get('free-auto').saveSortFields(noVision)
  const { json: stopped } = await request(custom)
  assert.deepEqual(
    stopped.models.map((row) => row.model),
    ['text-128k', 'text-2m', 'vision-1m', 'text-128k-big'],
    'a disabled field no longer splits the list (ttft now decides)',
  )
  await custom.services.get('free-auto').saveSortFields(order('availability', 'multimodal', 'ttft', 'context', 'maxTokens'))
  const { json: restored } = await request(custom)
  assert.deepEqual(
    restored.models.map((row) => row.model),
    baseOrder,
    'putting the chain back reproduces the default order exactly',
  )
  console.log('11 the sort chain drives the list: reorder changes it, disabling a field retires it')
}

// --- 12 --------------------------------------------------------------------
{
  // 归一化：任何输入都要收敛成合法的 5 字段排列。
  const keys = (fields) => fields.map((field) => field.key)
  assert.deepEqual(keys(normalizeFields(undefined)), ['availability', 'multimodal', 'ttft', 'context', 'maxTokens'])
  assert.deepEqual(keys(normalizeFields(null)), ['availability', 'multimodal', 'ttft', 'context', 'maxTokens'])
  assert.deepEqual(keys(normalizeFields([])), ['availability', 'multimodal', 'ttft', 'context', 'maxTokens'])
  assert.deepEqual(keys(normalizeFields('nonsense')), ['availability', 'multimodal', 'ttft', 'context', 'maxTokens'])
  assert.deepEqual(
    keys(normalizeFields([{ key: 'context' }])),
    ['context', 'availability', 'multimodal', 'ttft', 'maxTokens'],
    'missing keys are appended in the default order',
  )
  assert.deepEqual(
    normalizeFields([{ key: 'context', enabled: false }])[0],
    { key: 'context', enabled: false },
    'a disabled flag survives normalization',
  )
  assert.deepEqual(
    keys(normalizeFields([{ key: 'bogus' }, 'x', null, { key: 'context' }])),
    ['context', 'availability', 'multimodal', 'ttft', 'maxTokens'],
    'unknown keys are dropped',
  )
  assert.deepEqual(
    keys(normalizeFields([{ key: 'ttft' }, { key: 'ttft' }, { key: 'context' }])),
    ['ttft', 'context', 'availability', 'multimodal', 'maxTokens'],
    'duplicate keys collapse to the first entry',
  )
  assert.deepEqual(keys(normalizeFields([...perm().map((f) => ({ key: f.key }))])).length, 5, 'never more than five fields')

  // 磁盘上坏掉 / 缺字段 / 未知 key / 重复 key：静默回退或归一化，列表照常可用。
  const startWith = async (text) => {
    mkdirSync(join(DSH_HOME, 'free-auto'), { recursive: true })
    writeFileSync(SETTINGS_FILE, text)
    const world = start()
    const { res, json } = await request(world)
    assert.equal(res.status, 200, 'a broken settings file never breaks the list')
    return json
  }
  const fallback = await startWith('{ not json at all')
  assert.deepEqual(
    fallback.sortFields.map((field) => field.key),
    ['availability', 'multimodal', 'ttft', 'context', 'maxTokens'],
    'corrupt JSON falls back to the default chain',
  )
  assert.deepEqual(
    fallback.models.map((row) => row.model),
    ['vision-1m', 'text-128k', 'text-2m', 'text-128k-big'],
    'and the list ranks exactly as before',
  )
  const missing = await startWith(JSON.stringify({ version: 1, fields: [{ key: 'maxTokens', enabled: true }] }))
  assert.deepEqual(
    missing.sortFields.map((field) => field.key),
    ['maxTokens', 'availability', 'multimodal', 'ttft', 'context'],
    'one field in the file: the other four are appended in the default order',
  )
  assert.deepEqual(
    missing.models.map((row) => row.model),
    ['text-128k-big', 'text-128k', 'vision-1m', 'text-2m'],
    'the surviving field still drives the list',
  )
  const junk = await startWith(
    JSON.stringify({ fields: [{ key: 'nope' }, { key: 'context' }, { key: 'context' }, { key: 42 }] }),
  )
  assert.deepEqual(
    junk.sortFields.map((field) => field.key),
    ['context', 'availability', 'multimodal', 'ttft', 'maxTokens'],
    'unknown keys dropped, duplicates collapsed, missing keys appended',
  )
  assert.ok(
    junk.sortFields.every((field) => field.enabled === true),
    'appended fields default to enabled',
  )
  console.log('12 settings normalization: unknown/duplicate/missing/corrupt input all converge')
}

// --- 13 --------------------------------------------------------------------
{
  rmSync(SETTINGS_FILE, { force: true })
  const world = start()
  // GET：当前链 + 默认链 + 落盘位置（客户端渲染设置区要用的都在这）。
  const get = await request(world, { path: SETTINGS_PATH })
  assert.equal(get.res.status, 200)
  assert.equal(get.res.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(
    get.json.fields.map((field) => field.key),
    ['availability', 'multimodal', 'ttft', 'context', 'maxTokens'],
  )
  assert.deepEqual(
    get.json.defaults,
    order('availability', 'multimodal', 'ttft', 'context', 'maxTokens'),
    'the default chain travels with the answer',
  )
  assert.ok(get.json.defaults.every((field) => field.enabled === true), 'defaults come back fully enabled')
  assert.deepEqual(
    get.json.catalog.map((field) => field.label),
    ['可用性', '多模态', '首字延迟', '上下文', '输出上限'],
  )
  assert.ok(get.json.catalog.every((field) => field.hint), 'each field explains how it compares')
  const head = await request(world, { path: SETTINGS_PATH, method: 'HEAD' })
  assert.equal(head.res.status, 200)
  assert.equal(head.res.body, undefined, 'HEAD sends headers only')
  const notAllowed = await request(world, { path: SETTINGS_PATH, method: 'PUT' })
  assert.equal(notAllowed.res.status, 405, 'the settings route is GET/HEAD/POST only')
  assert.equal(notAllowed.res.body, 'method not allowed')

  // POST {fields:[…]}：落盘 + 立刻重排，响应里带着新列表与新链。
  const payload = order('ttft', 'availability', 'multimodal', 'context', 'maxTokens')
  const post = await request(world, { path: SETTINGS_PATH, method: 'POST', body: JSON.stringify({ fields: payload }) })
  assert.equal(post.res.status, 200)
  assert.deepEqual(
    post.json.models.map((row) => row.model),
    ['text-128k', 'text-2m', 'vision-1m', 'text-128k-big'],
    'the POST answers with the list already re-ranked',
  )
  assert.deepEqual(post.json.settings.fields, payload)
  assert.deepEqual(
    JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')),
    { version: 1, fields: payload },
    'the chain is persisted to <DSH_HOME>/free-auto/settings.json',
  )
  // 列表路由立刻用新链（缓存已被 POST 失效）。
  const after = await request(world)
  assert.deepEqual(
    after.json.models.map((row) => row.model),
    ['text-128k', 'text-2m', 'vision-1m', 'text-128k-big'],
  )
  assert.equal(
    post.json.updatedAt > 0,
    true,
    'a POST re-walks the cached list instead of serving the stale order',
  )

  // POST {reset:true}：一键恢复默认并落盘；"重启"（新 apply，重新读盘）后仍是默认。
  const reset = await request(world, { path: SETTINGS_PATH, method: 'POST', body: JSON.stringify({ reset: true }) })
  assert.equal(reset.res.status, 200)
  assert.deepEqual(
    reset.json.settings.fields,
    order('availability', 'multimodal', 'ttft', 'context', 'maxTokens'),
    'reset restores the default order and enables every field',
  )
  assert.deepEqual(
    JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).fields,
    order('availability', 'multimodal', 'ttft', 'context', 'maxTokens'),
    'the reset is persisted, not just kept in memory',
  )
  const restarted = start()
  const { json: rebooted } = await request(restarted)
  assert.deepEqual(
    rebooted.models.map((row) => row.model),
    ['vision-1m', 'text-128k', 'text-2m', 'text-128k-big'],
    'after a restart the default chain is what the file says',
  )

  // 非法请求体 / 写盘失败：400 与 500 + 可读错误文本（客户端要能显示出来）。
  const bad = await request(world, { path: SETTINGS_PATH, method: 'POST', body: '{oops' })
  assert.equal(bad.res.status, 400)
  assert.match(String(bad.res.body), /JSON/)
  // F1：缺 fields/reset 成员是调用方的错误 → 400（以前错误地报 500）；500 只留给写盘失败。
  const wrongShape = await request(world, { path: SETTINGS_PATH, method: 'POST', body: JSON.stringify({ nope: 1 }) })
  assert.equal(wrongShape.res.status, 400, 'a body with neither fields nor reset is a caller error, not a server failure')
  assert.match(String(wrongShape.res.body), /fields/)

  const broken = start({}, { requireFailure: join(DSH_HOME, 'free-auto') })
  const failed = await request(broken, {
    path: SETTINGS_PATH,
    method: 'POST',
    body: JSON.stringify({ fields: payload }),
  })
  assert.equal(failed.res.status, 500, 'a read-only settings directory is a 500, not a silent success')
  assert.match(String(failed.res.body), /EACCES/, 'the error text explains what went wrong')
  assert.ok(
    broken.logs.some(([, line]) => /保存排序设置失败/.test(line)),
    'and the failure is logged',
  )
  const stillWorks = await request(broken)
  assert.equal(stillWorks.res.status, 200, 'a failed save never takes the list down')
  assert.deepEqual(
    stillWorks.json.models.map((row) => row.model),
    ['vision-1m', 'text-128k', 'text-2m', 'text-128k-big'],
    'the in-memory chain is untouched by a failed write',
  )
  console.log('13 settings HTTP: GET/HEAD/POST, 405 otherwise, 400 on junk, 500 on a failed write')
}

// --- 14 --------------------------------------------------------------------
{
  // R1：停用一个字段必须真的把它踢出比较。这组夹具要让"忽略 enabled"给出**另一个**第一名：
  // 「多模态 → 输出上限」互相矛盾（视觉模型输出上限小，纯文本模型输出上限大）。
  clearSettings()
  clearProbe()
  const world = start()
  const visionFirst = order('multimodal', 'maxTokens', 'availability', 'ttft', 'context')
  await world.services.get('free-auto').saveSortFields(visionFirst)
  const { json: withVision } = await request(world)
  assert.deepEqual(
    withVision.models.map((row) => row.model),
    ['vision-1m', 'text-128k-big', 'text-128k', 'text-2m', 'tiny'],
    'multimodal first: the image-capable model leads',
  )
  const noVision = visionFirst.map((field) => ({ ...field, enabled: field.key !== 'multimodal' }))
  await world.services.get('free-auto').saveSortFields(noVision)
  const { json: without } = await request(world)
  assert.equal(
    without.models[0].model,
    'text-128k-big',
    'disabling multimodal hands the head to the biggest output ceiling (ignoring `enabled` would keep vision-1m first)',
  )
  assert.deepEqual(
    without.models.map((row) => row.model),
    ['text-128k-big', 'text-128k', 'vision-1m', 'text-2m', 'tiny'],
    'the disabled field is really retired, not just moved',
  )
  assert.notEqual(without.models[0].model, withVision.models[0].model, 'the on/off flag alone changes the head')

  // R1：链尾的 provider/model 名字定序不可配置。5 个字段全停用时只剩它，列表仍要稳定。
  clearSettings()
  const LANES = {
    'zz-lane': [{ id: 'zeta', name: 'Zeta' }, { id: 'alpha', name: 'Alpha' }],
    'aa-lane': [{ id: 'gamma', name: 'Gamma' }],
  }
  const ties = start({ sourceRoutes: ['zz-lane', 'aa-lane'] }, { catalog: LANES })
  await ties.services.get('free-auto').saveSortFields(perm().map((field) => ({ ...field, enabled: false })))
  const { json: tied } = await request(ties)
  assert.deepEqual(
    tied.models.map((row) => `${row.provider}/${row.model}`),
    ['aa-lane/gamma', 'zz-lane/alpha', 'zz-lane/zeta'],
    'with every field off the tail tie-break (provider, then model) still orders the list',
  )
  console.log('14 a disabled field is really retired; the tail tie-break keeps ties stable')
}

// --- 15 --------------------------------------------------------------------
{
  // R1：缓存要同时被"链变了"和"探测结果变了"约束；POST 之后必须重走，不能答旧缓存里的行。
  clearSettings()
  clearProbe()
  const world = start()
  await request(world) // 先把缓存捂热（默认链，text-2m 当时还是可用的）
  writeAvailability({ 'text-2m': { state: 'unavailable', detail: 'gone', at: Date.now() } })
  await world.services.get('free-auto').saveSortFields(order('maxTokens', 'availability', 'multimodal', 'ttft', 'context'))
  const { json: fresh } = await request(world)
  assert.equal(
    fresh.models.some((row) => row.model === 'text-2m'),
    false,
    'a chain change invalidates the cached rows even inside the TTL window',
  )
  assert.ok(fresh.hiddenModels.some((row) => row.model === 'text-2m'), 'and the walk behind it picks up the new probe file')
  assert.deepEqual(fresh.models.map((row) => row.model), ['text-128k-big', 'text-128k', 'vision-1m', 'tiny'])

  clearSettings()
  clearProbe()
  const posted = start()
  await request(posted) // 缓存变热：这份缓存里 text-2m 还在主列表
  writeAvailability({ 'text-2m': { state: 'unavailable', detail: 'gone', at: Date.now() } })
  const saved = await request(posted, {
    path: SETTINGS_PATH,
    method: 'POST',
    body: JSON.stringify({ fields: order('maxTokens', 'availability', 'multimodal', 'ttft', 'context') }),
  })
  assert.equal(saved.res.status, 200)
  assert.equal(
    saved.json.models.some((row) => row.model === 'text-2m'),
    false,
    'a POST re-walks the list instead of answering with cached rows',
  )
  assert.ok(saved.json.hiddenModels.some((row) => row.model === 'text-2m'), 'the POST answer reflects the probe file as it is now')
  console.log('15 the list cache is invalidated by the chain and by the probe file; a POST re-walks')
}

// --- 16 --------------------------------------------------------------------
{
  // R7：走列表期间链被改了——那份"旧链 + 旧探测"的行不许被打上新 revision 当成新鲜缓存。
  clearSettings()
  clearProbe()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const world = start({}, { hold: { provider: 'our-free-model', wait: gate } })
  const inflight = request(world) // 这次走列表会挂在目录读取上（它已经读过探测文件了）
  await new Promise((resolve) => setTimeout(resolve, 5))
  await world.services.get('free-auto').saveSortFields(order('maxTokens', 'availability', 'multimodal', 'ttft', 'context'))
  writeAvailability({ 'text-2m': { state: 'unavailable', detail: 'gone', at: Date.now() } })
  release()
  const first = await inflight
  assert.equal(first.res.status, 200, 'the in-flight walk still answers')
  const { json: after } = await request(world)
  assert.equal(
    after.models.some((row) => row.model === 'text-2m'),
    false,
    'a chain change during a walk never gets cached as a fresh walk',
  )
  assert.ok(after.hiddenModels.some((row) => row.model === 'text-2m'), 'and the walk after it sees the new probe file')
  console.log('16 a chain change during a walk is not cached as a fresh walk')
}

// --- 17 --------------------------------------------------------------------
{
  // R2/R4/R5：请求体上限、空 body、形状对但内容不可用的输入。
  clearSettings()
  clearProbe()
  const world = start()
  const route = world.routes.find((entry) => entry.path === SETTINGS_PATH)
  const sendChunks = async (chunks) => {
    const res = {
      status: 0,
      headers: null,
      body: undefined,
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(chunk) {
        this.body = chunk
      },
    }
    const pulls = { count: 0, resumed: 0 }
    const req = {
      method: 'POST',
      url: SETTINGS_PATH,
      resume() {
        pulls.resumed += 1
      },
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          pulls.count += 1
          yield chunk
        }
      },
    }
    await route.handler(req, res)
    return { res, pulls }
  }

  const chunk = Buffer.alloc(32 * 1024, 0x61)
  const big = await sendChunks([chunk, chunk, chunk, chunk]) // 128 KiB，上限 64 KiB
  assert.equal(big.res.status, 413, 'a settings body over the 64 KiB cap is refused')
  assert.match(String(big.res.body), /过大/)
  assert.ok(big.pulls.count < 4, `reading stops as soon as the cap is crossed (pulled ${big.pulls.count} of 4 chunks)`)
  assert.equal(big.pulls.resumed, 1, 'and the rest of the body is drained instead of left hanging')

  const empty = await sendChunks([''])
  assert.equal(empty.res.status, 400, 'an empty body is a bad request, not a save failure')
  assert.match(String(empty.res.body), /空/)
  const blank = await sendChunks(['   \n '])
  assert.equal(blank.res.status, 400, 'a whitespace-only body is a bad request too')
  const emptyFields = await sendChunks([JSON.stringify({ fields: [] })])
  assert.equal(emptyFields.res.status, 400, 'an empty field list is refused instead of silently falling back')
  assert.match(String(emptyFields.res.body), /availability/, 'the error names the keys that would be accepted')
  const unknownOnly = await sendChunks([JSON.stringify({ fields: [{ key: 'nope' }, { key: 42 }] })])
  assert.equal(unknownOnly.res.status, 400, 'a field list without a single known key is refused too')

  // F1：缺 `fields`/`reset` 成员是**调用方**的错误，不是写盘失败——必须 400，不能 5xx。
  const chainBefore = (await request(world)).json.sortFields.map((field) => [field.key, field.enabled])
  for (const bad of ['{"version":1}', '{"reset":false}', 'null', '[1,2,3]', '"nope"', '42']) {
    const refused = await sendChunks([bad])
    assert.equal(refused.res.status, 400, `${bad} is a caller error (400), not a server failure`)
    assert.match(String(refused.res.body), /\{fields/, `${bad} gets the readable "needs {fields…}" text`)
  }
  const { res: afterBad, json: afterBadJson } = await request(world)
  assert.equal(afterBad.status, 200, 'the list still answers after those bodies')
  assert.deepEqual(
    afterBadJson.sortFields.map((field) => [field.key, field.enabled]),
    chainBefore,
    'and none of them touched the live chain',
  )

  const { res: stillOk, json: ok } = await request(world)
  assert.equal(stillOk.status, 200, 'the list keeps working after a refused body')
  assert.equal(ok.models.length, 5, 'nothing was half-written by the refused requests')
  console.log('17 body cap (413), empty body and unusable field lists (400), list still healthy')
}

// --- 18 --------------------------------------------------------------------
{
  // R3：读与写必须走同一个 fs 抽象——写进虚拟盘的，重启后必须从虚拟盘读回来。
  clearSettings()
  assert.equal(existsSync(SETTINGS_FILE), false)
  const vdisk = new Map()
  const fakeFs = {
    mkdirSync(path) {
      vdisk.set(String(path), { dir: true })
    },
    writeFileSync(path, data) {
      vdisk.set(String(path), { data: String(data) })
    },
    existsSync(path) {
      return vdisk.has(String(path))
    },
    readFileSync(path) {
      const hit = vdisk.get(String(path))
      if (!hit?.data) throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' })
      return hit.data
    },
  }
  const chain = order('maxTokens', 'availability', 'multimodal', 'ttft', 'context')
  const virtual = start({}, { fs: fakeFs })
  const saved = await request(virtual, { path: SETTINGS_PATH, method: 'POST', body: JSON.stringify({ fields: chain }) })
  assert.equal(saved.res.status, 200, 'the host-supplied fs accepts the write')
  assert.ok(vdisk.has(SETTINGS_FILE), 'the chain lands on the fs the host gave us')
  assert.equal(existsSync(SETTINGS_FILE), false, 'and nothing is written to the real disk')
  const rebooted = start({}, { fs: fakeFs })
  const { json: reread } = await request(rebooted)
  assert.deepEqual(
    reread.sortFields.map((field) => field.key),
    ['maxTokens', 'availability', 'multimodal', 'ttft', 'context'],
    'a restart reads the chain back through the same fs abstraction',
  )
  assert.equal(reread.models[0].model, 'text-128k-big', 'and the chain it read really drives the list')

  // R6：`enabled` 只认"停用"那一侧；其余值（null / 缺字段 / 'yes' / 2）一律回退默认＝启用。
  const coerced = (value) => normalizeFields([{ key: 'multimodal', enabled: value }])[0].enabled
  assert.equal(coerced(false), false)
  assert.equal(coerced(0), false, 'a hand-written "enabled": 0 means off')
  assert.equal(coerced('false'), false)
  assert.equal(coerced(true), true)
  assert.equal(coerced(1), true)
  assert.equal(coerced(undefined), true)
  assert.equal(coerced(null), true, 'a null flag falls back to the default (on)')
  assert.equal(coerced('yes'), true, 'and so does anything else')
  assert.equal(coerced(2), true)

  clearSettings()
  mkdirSync(join(DSH_HOME, 'free-auto'), { recursive: true })
  writeFileSync(
    SETTINGS_FILE,
    JSON.stringify({
      version: 1,
      fields: [
        { key: 'maxTokens', enabled: 0 },
        { key: 'availability', enabled: true },
        { key: 'multimodal', enabled: true },
        { key: 'ttft', enabled: true },
        { key: 'context', enabled: true },
      ],
    }),
  )
  const { json: off } = await request(start())
  assert.deepEqual(
    off.sortFields.map((field) => [field.key, field.enabled]),
    [['maxTokens', false], ['availability', true], ['multimodal', true], ['ttft', true], ['context', true]],
    '"enabled": 0 survives the round trip as a disabled field',
  )
  assert.equal(off.models[0].model, 'vision-1m', 'and that field is really out of the comparison')
  console.log('18 read and write share one fs abstraction; `enabled` only treats the off side as off')
}

// --- 19 --------------------------------------------------------------------
{
  // 线上回归（用户真机 `dsh web` 启动即崩）：profile 里**根本没有 fs 服务**，
  // `apply` 构造期读 `ctx.fs` → cordis 抛 `cannot get property "fs" without inject`
  // → 插件整体 apply 失败 → 面板上的模型列表和「重新探测」「设置」全消失。
  // `fs: null` 就是这个现状：连 fs 服务都没有，夹具照真机让属性访问抛。
  clearSettings()
  const world = start({}, { fs: null })
  assert.throws(() => world.ctx.fs, /without inject/, 'the fixture really throws on ctx.fs, like a real fiber')
  const list = await request(world)
  assert.equal(list.res.status, 200, 'a ctx with no fs service at all still serves the list')
  assert.ok(list.json.models.length > 0, 'and the list is not empty')
  assert.equal(list.json.models[0].rank, 1, 'with ranks assigned as usual')
  const saved = await request(world, {
    path: SETTINGS_PATH,
    method: 'POST',
    body: JSON.stringify({ fields: order('maxTokens', 'availability', 'multimodal', 'ttft', 'context') }),
  })
  assert.equal(saved.res.status, 200, 'and it can still save settings through the node:fs fallback')
  assert.ok(existsSync(SETTINGS_FILE), 'the chain really lands on the DSH_HOME disk')
  const rebooted = await request(start({}, { fs: null }))
  assert.deepEqual(
    rebooted.json.sortFields.map((field) => field.key),
    ['maxTokens', 'availability', 'multimodal', 'ttft', 'context'],
    'a restart without any fs service reads the same file back',
  )
  const reset = await request(world, { path: SETTINGS_PATH, method: 'POST', body: JSON.stringify({ reset: true }) })
  assert.equal(reset.res.status, 200, '{reset:true} works without an fs service too')
  assert.deepEqual(
    JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).fields,
    order('availability', 'multimodal', 'ttft', 'context', 'maxTokens'),
    'and it is persisted',
  )
  clearSettings()
  console.log('19 no fs service (the real profile): apply survives and everything still works on node:fs')
}

// --- 20 --------------------------------------------------------------------
{
  // 真机式复现，不启第二个 dsh web：用真机那份 cordis 建**真 Context**，在真 fiber 里调 apply。
  // 真 fiber 里 `ctx.fs` 一定会抛，所以这一节是"线上崩法"的等价复现。
  const candidates = [process.env.FREE_AUTO_CORDIS, join(process.cwd(), 'node_modules/@deepseek-ai/cordis')]
  try {
    const npx = join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx')
    for (const entry of readdirSync(npx)) candidates.push(join(npx, entry, 'node_modules/@deepseek-ai/cordis'))
  } catch {
    // 没有 npx 缓存：只剩上面两个候选
  }
  let Context
  for (const dir of candidates) {
    if (!dir) continue
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const entry = join(dir, typeof pkg.main === 'string' ? pkg.main : 'lib/index.js')
      const module = await import(pathToFileURL(entry).href)
      if (typeof module.Context === 'function') {
        Context = module.Context
        break
      }
    } catch {
      // 换下一个候选
    }
  }
  if (!Context) {
    console.log('20 skipped: no real cordis on this machine to build a Context with')
  } else {
    clearSettings()
    const routes = []
    const real = new Context()
    real.provide('webServer', {
      register(route) {
        routes.push(route)
        return () => {}
      },
    })
    real.provide('llm', {
      registerAdapter: () => Object.assign(() => {}, { replace: () => {} }),
      listProviders: async () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
    })
    let applied = 0
    let failure = null
    real.plugin({
      name: 'free-auto-regression-runner',
      apply(inner) {
        assert.throws(() => inner.fs, /without inject/, 'a real cordis fiber throws on a service it did not inject')
        assert.equal(inner.reflect.get('fs', true), undefined, 'and its non-throwing API says "not provided"')
        try {
          plugin.apply(inner, {})
          applied += 1
        } catch (error) {
          failure = error
        }
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(failure, null, `apply must not throw on a real Context without an fs service (${failure?.message})`)
    assert.equal(applied, 1)
    const world = { routes }
    const list = await request(world)
    assert.equal(list.res.status, 200, 'the real Context serves the list')
    const saved = await request(world, {
      path: SETTINGS_PATH,
      method: 'POST',
      body: JSON.stringify({ fields: order('maxTokens', 'availability', 'multimodal', 'ttft', 'context') }),
    })
    assert.equal(saved.res.status, 200, 'and saves through node:fs')
    assert.ok(existsSync(SETTINGS_FILE), 'the real-Context run wrote the settings file')
    clearSettings()
    console.log('20 real cordis Context without fs: apply does not throw, routes answer 200')
  }
}

console.log('dsh-free-auto: all smoke assertions passed')