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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as plugin from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * A controlled DSH_HOME: the host half reads availability verdicts and measured
 * stats from <DSH_HOME>/our-free-model/, and the real files must not leak into
 * the assertions.
 */
const DSH_HOME = mkdtempSync(join(tmpdir(), 'free-auto-smoke-'))
process.env.DSH_HOME = DSH_HOME

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
const REPROBE_URL = '/api/our-free-model/reprobe'

function makeCtx({ catalog = CATALOG, selection, modelWithoutDetail } = {}) {
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

  return { ctx, calls, routes, logs, disposes, services, registered: () => registered }
}

function start(config = {}, options = {}) {
  const world = makeCtx(options)
  plugin.apply(world.ctx, config)
  return world
}

async function request(world, { method = 'GET', path } = {}) {
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
  await route.handler({ method }, res)
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
    [MODELS_PATH, REFRESH_PATH],
    'one read route and one cached-walk refresh route',
  )
  assert.ok(world.routes.every((route) => route.kind === 'exact'))
  assert.ok(world.services.has('free-auto'), 'the plugin provides an inspection handle')
  console.log('1  the Auto-Free adapter route; a read route and a refresh route, both exact')
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
  console.log('8  client half: floating panel, folded group, re-probe, no dock badge, no SSE')
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

console.log('dsh-free-auto: all smoke assertions passed')