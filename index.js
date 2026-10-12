/**
 * dsh-free-auto — 模型速切 / Model Switcher（含 Auto-Free 自动路由）
 *
 * 两条腿：
 *
 *   A. 手动速切（原样保留）——读取来源路由的模型表，按「可用性 → 多模态 →
 *      首 token 延迟 → 上下文长 → 输出上限大」排序（这一串可以在面板的「设置」里
 *      改序 / 停用，链尾的 provider/model 名字定序永远保留），通过
 *      GET /api/free-auto/models 交给客户端半身；会话页右下角的悬浮按钮点开列表，
 *      点模型名即切换当前会话。排序链存在 <DSH_HOME>/free-auto/settings.json，
 *      由 GET/POST /api/free-auto/settings 读写。
 *
 *   B. Auto-Free（可选的第一行）——注册一个 provider 路由 `free-auto`，只广告一个
 *      模型 `auto-free`。选中它以后，请求在这里被转成"列表最上方的那个模型"：
 *        · 同一个会话只选举一次，之后固定用这个模型（会话内不切换）；
 *        · 该模型限流 / 额度用尽 / 超时（switchCodes）时，把它放进冷却、立刻重扫列表
 *          （availability.json 也在这一步被重新读取）、重新选举，并在同一次请求里
 *          透明重试，会话不会因此中断；
 *        · 子智能体（subagent / delegate）避开最优模型：从已探测的非首位模型里随机
 *          挑一个（首 token 延迟不超过最优模型的 subagent.maxTtftFactor 倍），没有
 *          就退化到未探测模型随机，再不行才用最优模型。
 *
 * 上游换了模型表不需要改这个插件：列表、选举、延迟数据每次都是从上游目录与
 * availability.json / stats.json 现算的。
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'free-auto'
/** The list is read from other plugins' catalogs; this plugin owns one adapter. */
export const inject = ['llm']
// 注意：`fs` **故意不放进 inject**——本 profile 里根本没有 fs 服务，声明它只会让插件永远等不到。
// 需要 fs 的地方走 `resolveFs()`（cordis 的非抛取值 API + node:fs 回退，见下）。

const ROUTE_PREFIX = '/api/free-auto'
const MODELS_PATH = `${ROUTE_PREFIX}/models`
/** 客户端点「重新探测」后用它打掉缓存、立刻重扫（不带 GET 的语义副作用）。 */
const REFRESH_PATH = `${ROUTE_PREFIX}/refresh`
/** 排序设置（字段顺序 + 启用与否）的读写口，面板里的「设置」用。 */
const SETTINGS_PATH = `${ROUTE_PREFIX}/settings`
/** dsh-our-free-model 的 region 线路：按出口地区放行，本机通常用不了。 */
const REGION_ROUTE = 'our-free-model-region'
/** dsh-our-free-model 在 $DSH_HOME 下的数据目录名（可用性/统计就在里面）。 */
const CHILD_DIR = 'our-free-model'

/** 本插件自己注册的路由与那个唯一的虚拟模型。 */
const ROUTE = 'free-auto'
const ROUTE_LABEL = 'Auto-Free'
const AUTO_MODEL = 'auto-free'
const AUTO_NAME = 'Auto-Free'

const DEFAULT_SETTINGS = {
  /** 列出这些路由上的模型。默认是 dsh-our-free-model 注册的两条免费线路。 */
  sourceRoutes: ['our-free-model', REGION_ROUTE],
  /** 列表在这段时间内直接复用，避免每次请求都去翻上游目录。 */
  candidateTtlMs: 10_000,
  /** 连同 DSH 已知的其它 provider 一起列出（默认只列免费线路）。 */
  includeAllProviders: false,
  /**
   * 上游给了这些可用性状态的模型不进主列表（改为放进 hiddenModels 折叠展示）：
   * 限流 / 地区受限 / 不可用。置为 [] 就是全都列出来并带上状态标记。
   */
  hideStates: ['unavailable', 'throttled', 'region-blocked'],
  /** 是否注册 Auto-Free 路由（关掉就只剩手动速切）。 */
  autoFree: true,
  /** 这些失败码触发"冷却 + 重扫列表 + 透明重试"（免费线路的额度用尽也是 RATE_LIMIT）。 */
  switchCodes: ['RATE_LIMIT', 'QUOTA', 'QUOTA_EXCEEDED', 'REGION_BLOCKED', 'LANE_LOCKED', 'TIMEOUT'],
  /** 命中上面的失败码后，这个模型在这么久之内不再被选举。 */
  cooldownMs: 600_000,
  retry: { maxAttempts: 3, firstChunkTimeoutMs: 120_000 },
  /** 子智能体的取模规则（见文件头说明）。 */
  subagent: { avoidBest: true, maxTtftFactor: 5 },
}

// --- Configurable sort chain (the panel's "设置") -------------------------

/**
 * 用户能排的排序字段。`key` 是落盘标识，`label` 只是给客户端渲染用，
 * `hint` 解释这个字段怎么比。默认顺序 = 数组顺序 = 本项目一直以来的顺序；
 * 末尾的 provider/model 名字定序不属于字段，永远保留（否则改序后列表会抖动）。
 */
export const SORT_FIELDS = [
  { key: 'availability', label: '可用性', hint: '可用 › 未探测 › 限流 › 地区受限 › 不可用' },
  { key: 'multimodal', label: '多模态', hint: '支持图片的排在纯文本前面' },
  { key: 'ttft', label: '首字延迟', hint: '实测均值优先，其次探测值；没有数据的排在后面' },
  { key: 'context', label: '上下文', hint: 'contextWindow 大者优先' },
  { key: 'maxTokens', label: '输出上限', hint: 'defaultMaxTokens 大者优先' },
]

const SORT_KEYS = SORT_FIELDS.map((field) => field.key)
const DEFAULT_FIELDS = SORT_FIELDS.map((field) => ({ key: field.key, enabled: true }))
/** `$DSH_HOME/free-auto/settings.json`：本插件自己的目录（DSH_HOME 优先，回退 ~/.dsh）。 */
const SETTINGS_DIR = 'free-auto'
const SETTINGS_FILE = 'settings.json'

const defaultSortFields = () => DEFAULT_FIELDS.map((field) => ({ ...field }))

/**
 * `enabled` 只认"停用"这一侧：`false` / `0` / `'false'` 是停用，
 * 其它任何值（`true` / `1` / `'true'` / `null` / 缺字段 / 乱七八糟）都退回默认＝启用。
 * 手写 settings.json 的人写 `"enabled": 0` 或 `"false"` 也算停用，不会被悄悄当成开。
 */
export function coerceEnabled(value) {
  return !(value === false || value === 0 || value === 'false')
}

/**
 * 并集归一化：未知 key 丢弃、重复 key 只留第一条、缺失 key 按默认顺序补到末尾。
 * 任何输入（损坏 / 缺字段 / 未知 key / 重复 key / null）都会收敛成一个合法的 5 字段排列。
 */
export function normalizeFields(input) {
  const kept = []
  const seen = new Set()
  for (const entry of Array.isArray(input) ? input : []) {
    if (!entry || typeof entry !== 'object') continue
    const key = String(entry.key ?? '')
    if (!SORT_KEYS.includes(key) || seen.has(key)) continue
    seen.add(key)
    kept.push({ key, enabled: coerceEnabled(entry.enabled) })
  }
  for (const key of SORT_KEYS) {
    if (!seen.has(key)) kept.push({ key, enabled: true })
  }
  return kept
}

/** 落盘前的那一层的形状（读回来时还会再归一化一遍）。 */
function serializeFields(fields) {
  return { version: 1, fields: normalizeFields(fields).map(({ key, enabled }) => ({ key, enabled })) }
}

/** 设置只存这一个文件；目录不存在就建，读不到 / JSON 坏 / 结构非法一律回退默认。 */
function settingsFile() {
  let home = process.env.DSH_HOME
  if (!home) {
    try {
      home = join(homedir(), '.dsh')
    } catch {
      return null
    }
  }
  return home ? join(home, SETTINGS_DIR, SETTINGS_FILE) : null
}

const NODE_FS = { mkdirSync, writeFileSync, existsSync, readFileSync }
const FS_METHODS = ['mkdirSync', 'writeFileSync', 'existsSync', 'readFileSync']

/**
 * 解析 fs 服务：优先用宿主提供的 `fs`，但**只有那四个同步方法齐全**
 * （mkdirSync / writeFileSync / existsSync / readFileSync）才用它，其它情况一律
 * 回退 `node:fs`（本 Store 的读和写共用这一个结果，不会"写虚拟盘、读真实盘"）。
 *
 * 读服务只用 cordis 的非抛 API `ctx.reflect.get('fs', true)`：它明确不要求 inject，
 * 服务不存在时返回 undefined。**绝不允许用属性访问去探服务**——真机上没注入的服务，
 * 异常是在 getter 内部抛的（`cannot get property "fs" without inject`），
 * 所以 `ctx?.fs` 的可选链救不了。
 *
 * 本 profile 里实际生效的是 `node:fs`：`@deepseek-ai/dsh-fs` 不带同步方法
 * （`mkdirSync`/`writeFileSync`/`existsSync`/`readFileSync` 一个都没有，整个 `lib/index.js`
 * 里也没有任何 `Sync` 标识符——只有 `asynchronous` 这个词里出现过这串字母），
 * 于是即使同一条 cordis 树里别的 fiber `provide` 了 `fs` 服务，上面的 `complete()` 也不成立、
 * 照样回退。哪天宿主补上同步方法，这里就会自动改用宿主 fs（那之后读写都落在宿主 fs 上，
 * 不会半套混用）——那是设计意图，不是 bug。
 */
function resolveFs(ctx) {
  const complete = (value) => value && FS_METHODS.every((name) => typeof value[name] === 'function')
  try {
    const provided = ctx?.reflect?.get?.('fs', true)
    if (complete(provided)) return provided
  } catch {
    // 假 ctx / 没有 reflect 的老宿主：继续走下面的兼容路径
  }
  try {
    const direct = ctx?.fs
    if (complete(direct)) return direct
  } catch {
    // 真机上没注入 fs 时属性访问会抛：静默回退 node:fs
  }
  return NODE_FS
}

/**
 * 惰性 fs：把解析推迟到**第一次真正的 I/O**，并把结果固定下来——这样这个 Store 的读和写
 * 始终是同一个抽象（不会"写虚拟盘、读真实盘"）。
 *
 * 注意 apply 期其实就会解析一次：`SortSettingsStore` 构造时会 `load()` 读一次盘
 * （`existsSync` 是这条路径上的第一次 I/O）。被修掉的从来不是"apply 期不解析"，
 * 而是"解析会抛"——`resolveFs` 只走不抛的 `ctx.reflect.get`，服务不存在/不完整就回退
 * `node:fs`，所以构造期这次解析不会把整个 apply 炸掉。
 */
function lazyFs(ctx) {
  let resolved
  const real = () => (resolved ??= resolveFs(ctx))
  return {
    mkdirSync: (...args) => real().mkdirSync(...args),
    writeFileSync: (...args) => real().writeFileSync(...args),
    existsSync: (...args) => real().existsSync(...args),
    readFileSync: (...args) => real().readFileSync(...args),
  }
}

/**
 * 排序设置的 Store：内存里只留"当前生效的字段链"，读盘在 apply 时做一次
 * （构造期的 `load()` 就是那条惰性 fs 的第一次 I/O）、写盘（HTTP POST）之后刷新——
 * 列表生成因此永远不用同步读盘。
 */
class SortSettingsStore {
  constructor(logger, fs = NODE_FS) {
    this.logger = logger
    this.fs = fs
    this.file = settingsFile()
    this.revision = 0
    this.fields = this.load()
  }

  load() {
    const file = this.file
    if (!file) return defaultSortFields()
    try {
      if (!this.fs.existsSync(file)) return defaultSortFields()
      const parsed = JSON.parse(this.fs.readFileSync(file, 'utf8'))
      return normalizeFields(parsed?.fields)
    } catch (error) {
      // 静默回退默认：设置坏了绝不牵连列表
      this.logger?.warn?.(`[free-auto] could not read ${file}: ${message(error)}`)
      return defaultSortFields()
    }
  }

  /** 现在的排序链（同步、无 I/O）。 */
  current() {
    return this.fields
  }

  /** 落盘并让新排序立刻生效；写失败原样抛出（HTTP 层会把它变成可读的错误）。 */
  save(fields) {
    const normalized = normalizeFields(fields)
    const file = this.file
    if (!file) throw new Error('free-auto: 找不到可写的设置路径（DSH_HOME 与 home 都不可用）')
    try {
      this.fs.mkdirSync(join(file, '..'), { recursive: true })
      this.fs.writeFileSync(file, `${JSON.stringify(serializeFields(normalized), null, 2)}\n`, 'utf8')
    } catch (error) {
      throw new Error(`free-auto: 设置写入 ${file} 失败：${message(error)}`)
    }
    this.fields = normalized
    this.revision += 1
    return normalized
  }

  /** GET 的返回：当前生效的排序链 + 默认排序链 + 落盘位置。 */
  describe() {
    return {
      ok: true,
      fields: this.fields.map((field) => ({ ...field })),
      defaults: defaultSortFields(),
      catalog: SORT_FIELDS.map((field) => ({ ...field })),
      ...(this.file ? { path: this.file } : {}),
    }
  }
}

/** 排序依据：可用 > 未探测 > 限流 > 地区受限 > 不可用。 */
const STATE_RANK = { available: 0, unknown: 1, throttled: 2, 'region-blocked': 3, unavailable: 4 }
const stateRank = (state) => STATE_RANK[state] ?? 1
/** 没有延迟数据时排在有数据的模型之后。 */
const NO_TTFT = Number.MAX_SAFE_INTEGER
/** 思考档位的相对高低（用来把用户选的档位投影到目标模型自己的阶梯上）。 */
const EFFORT_RANK = {
  off: 0,
  none: 0,
  disabled: 0,
  minimal: 1,
  light: 2,
  low: 3,
  medium: 4,
  balanced: 4,
  high: 5,
  xhigh: 6,
  max: 7,
  ultra: 8,
  deep: 9,
}
const effortRank = (id) => EFFORT_RANK[String(id ?? '').toLowerCase()] ?? 5
const AUTOMATIC = { id: 'auto', name: 'Auto' }
const FALLBACK_CONTEXT = 131_072
const FALLBACK_MAX_TOKENS = 8_192
const MAX_ATTEMPTS_CEILING = 5
const STALLED = Symbol('free-auto.stalled')
const NO_FREE_MODEL_MESSAGE =
  'free-auto: 当前没有任何可用的免费模型（上游目录为空）；请检查 dsh-our-free-model 是否启用'

const targetKey = (row) => `${row.provider}\u0000${row.model}`

export const SCHEMA_SPECIFIER = '@deepseek-ai/schemastery'

const message = (error) => (error && error.message ? String(error.message) : String(error))

// --- Availability & measured latency (a read-only peek at dsh-our-free-model) ---

function childDir() {
  const homes = []
  if (process.env.DSH_HOME) homes.push(process.env.DSH_HOME)
  try {
    homes.push(join(homedir(), '.dsh'))
  } catch {
    // no home directory: DSH_HOME is the only candidate
  }
  for (const home of homes) {
    const dir = join(home, CHILD_DIR)
    try {
      if (existsSync(dir)) return dir
    } catch {
      // unreadable path: try the next candidate
    }
  }
  return null
}

function readJson(file, logger) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    logger?.warn?.(`[free-auto] could not read ${file}: ${message(error)}`)
    return null
  }
}

const positive = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null
}

/**
 * dsh-our-free-model 把每个模型的探测结论记在 availability.json 里
 * （`{ results: { <id>: { state, detail, latencyMs, ttftMs, at } } }`）。从外部只有这一条
 * 路能区分"限流"：LLM 目录接口不带可用性字段，而限流的模型仍然是主线路的成员，
 * 所以光看 listModels 是看不出来的。读不到就返回空表，一切照旧（只按线路判断）。
 */
function readAvailability(logger) {
  const dir = childDir()
  if (!dir) return new Map()
  const file = join(dir, 'availability.json')
  if (!existsSync(file)) return new Map()
  const parsed = readJson(file, logger)
  const results = parsed?.results && typeof parsed.results === 'object' ? parsed.results : {}
  const verdicts = new Map()
  for (const [id, verdict] of Object.entries(results)) {
    const state = String(verdict?.state ?? '')
    if (!id || !state) continue
    verdicts.set(id, {
      state,
      detail: typeof verdict?.detail === 'string' ? verdict.detail : '',
      ttftMs: positive(verdict?.ttftMs),
      latencyMs: positive(verdict?.latencyMs),
      probedAt: positive(verdict?.at),
    })
  }
  return verdicts
}

/**
 * stats.json 记着真实请求的测量值（每天每模型的 ttftMs/ttftSamples/decodeMs/
 * decodeTokens）。顶层的 models[id] 只有 token 计数，所以这里按天累加，算出平均
 * 首 token 延迟与解码速度——当探测值已经过时，它才是更有代表性的等待时间。
 */
function readStats(logger) {
  const dir = childDir()
  if (!dir) return new Map()
  const file = join(dir, 'stats.json')
  if (!existsSync(file)) return new Map()
  const parsed = readJson(file, logger)
  const days = parsed?.days && typeof parsed.days === 'object' ? parsed.days : {}
  const totals = new Map()
  for (const day of Object.values(days)) {
    const models = day?.models && typeof day.models === 'object' ? day.models : {}
    for (const [id, entry] of Object.entries(models)) {
      if (!id || !entry || typeof entry !== 'object') continue
      const sum = totals.get(id) ?? { ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0, calls: 0, failed: 0 }
      sum.ttftMs += Number(entry.ttftMs) || 0
      sum.ttftSamples += Number(entry.ttftSamples) || 0
      sum.decodeMs += Number(entry.decodeMs) || 0
      sum.decodeTokens += Number(entry.decodeTokens) || 0
      sum.calls += Number(entry.calls) || 0
      sum.failed += Number(entry.failed) || 0
      totals.set(id, sum)
    }
  }
  const stats = new Map()
  for (const [id, sum] of totals) {
    const ttft = sum.ttftSamples > 0 ? positive(sum.ttftMs / sum.ttftSamples) : null
    const tps = sum.decodeMs > 0 ? Math.round((sum.decodeTokens / (sum.decodeMs / 1000)) * 10) / 10 : null
    stats.set(id, {
      ttftMs: ttft,
      tps: tps !== null && tps > 0 ? tps : null,
      calls: sum.calls,
      failed: sum.failed,
    })
  }
  return stats
}

// --- Config descriptor (defensive; see loadSchema) ------------------------

function schemaBases() {
  const bases = [import.meta.url]
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dirs = []
  if (process.env.DSH_PROFILE_DIR) dirs.push(process.env.DSH_PROFILE_DIR)
  if (process.env.DSH_PROFILE) dirs.push(join(home, 'profiles', process.env.DSH_PROFILE))
  try {
    for (const entry of readdirSync(join(home, 'profiles'))) dirs.push(join(home, 'profiles', entry))
  } catch {
    // no profiles directory: the bases above are all we can try
  }
  for (const dir of dirs) bases.push(pathToFileURL(join(dir, 'index.js')).href)
  return bases
}

/**
 * DSH derives the Settings form from this plugin's own `Config` descriptor. A
 * `link:` package resolves @deepseek-ai/schemastery only through a profile's
 * node_modules, so the module is loaded through createRequire inside try/catch:
 * a deployment that cannot resolve it loses the Settings form, never the plugin.
 */
function loadSchema() {
  for (const base of schemaBases()) {
    try {
      const require = createRequire(base)
      const z = require(SCHEMA_SPECIFIER)
      if (typeof z?.object !== 'function') continue
      return z.object({
        sourceRoutes: z.array(z.string()).default([...DEFAULT_SETTINGS.sourceRoutes]),
        candidateTtlMs: z.number().default(DEFAULT_SETTINGS.candidateTtlMs),
        includeAllProviders: z.boolean().default(DEFAULT_SETTINGS.includeAllProviders),
        hideStates: z.array(z.string()).default([...DEFAULT_SETTINGS.hideStates]),
        autoFree: z.boolean().default(DEFAULT_SETTINGS.autoFree),
        switchCodes: z.array(z.string()).default([...DEFAULT_SETTINGS.switchCodes]),
        cooldownMs: z.number().default(DEFAULT_SETTINGS.cooldownMs),
        retry: z.object({
          maxAttempts: z.number().default(DEFAULT_SETTINGS.retry.maxAttempts),
          firstChunkTimeoutMs: z.number().default(DEFAULT_SETTINGS.retry.firstChunkTimeoutMs),
        }),
        subagent: z.object({
          avoidBest: z.boolean().default(DEFAULT_SETTINGS.subagent.avoidBest),
          maxTtftFactor: z.number().default(DEFAULT_SETTINGS.subagent.maxTtftFactor),
        }),
      })
    } catch {
      // try the next base
    }
  }
  return undefined
}

export const Config = loadSchema()

function resolveSettings(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const strings = (value, fallback) =>
    Array.isArray(value)
      ? value.map((entry) => String(entry ?? '').trim()).filter(Boolean)
      : [...fallback]
  const number = (value, fallback, min = 0) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
  }
  const retry = raw.retry && typeof raw.retry === 'object' ? raw.retry : {}
  const subagent = raw.subagent && typeof raw.subagent === 'object' ? raw.subagent : {}
  return {
    sourceRoutes: strings(raw.sourceRoutes, DEFAULT_SETTINGS.sourceRoutes),
    candidateTtlMs: number(raw.candidateTtlMs, DEFAULT_SETTINGS.candidateTtlMs),
    includeAllProviders: raw.includeAllProviders === true,
    hideStates: strings(raw.hideStates, DEFAULT_SETTINGS.hideStates),
    autoFree: raw.autoFree !== false,
    switchCodes: strings(raw.switchCodes, DEFAULT_SETTINGS.switchCodes).map((code) => code.toUpperCase()),
    cooldownMs: number(raw.cooldownMs, DEFAULT_SETTINGS.cooldownMs),
    retry: {
      maxAttempts: Math.min(
        MAX_ATTEMPTS_CEILING,
        Math.max(1, Math.round(number(retry.maxAttempts, DEFAULT_SETTINGS.retry.maxAttempts, 1))),
      ),
      firstChunkTimeoutMs: number(retry.firstChunkTimeoutMs, DEFAULT_SETTINGS.retry.firstChunkTimeoutMs),
    },
    subagent: {
      avoidBest: subagent.avoidBest !== false,
      maxTtftFactor: number(subagent.maxTtftFactor, DEFAULT_SETTINGS.subagent.maxTtftFactor, 1),
    },
  }
}

// --- The ranked list ------------------------------------------------------

/** One list row. Metadata is display-only: nothing here validates a call. */
function describe(provider, model, info, state, verdict, stats) {
  const modalities = Array.isArray(info?.inputModalities) ? info.inputModalities.map(String) : []
  const window = info?.context?.contextWindow
  const output = info?.defaultMaxTokens
  const declared = (Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : [])
    .map((effort) => ({ id: String(effort?.id ?? ''), name: String(effort?.name ?? effort?.id ?? '') }))
    .filter((effort) => effort.id)
  const own = info?.reasoning?.defaultEffort === undefined ? '' : String(info.reasoning.defaultEffort)
  // 排序用的是"最有代表性的首 token 延迟"：真实请求的均值优先，退而求其次才是
  // 最近一次探测的单次值（探测值有时是一次异常慢的样本）。
  const probe = verdict?.ttftMs ?? null
  const average = stats?.ttftMs ?? null
  return {
    provider,
    model,
    name: String(info?.name ?? model),
    ...(typeof info?.description === 'string' && info.description ? { description: info.description } : {}),
    state: String(state ?? '') || 'unknown',
    ...(verdict?.detail ? { detail: verdict.detail } : {}),
    vision: modalities.includes('image'),
    contextWindow: Number.isSafeInteger(window) && window > 0 ? window : null,
    maxTokens: Number.isSafeInteger(output) && output > 0 ? output : null,
    ttftMs: average ?? probe,
    ttftSource: average !== null ? 'stats' : probe !== null ? 'probe' : '',
    avgTtftMs: average,
    probeTtftMs: probe,
    latencyMs: verdict?.latencyMs ?? null,
    probedAt: verdict?.probedAt ?? null,
    tps: stats?.tps ?? null,
    calls: Number.isFinite(stats?.calls) ? stats.calls : null,
    failed: Number.isFinite(stats?.failed) ? stats.failed : null,
    reasoning: {
      efforts: declared,
      defaultEffort: declared.some((effort) => effort.id === own) ? own : (declared[0]?.id ?? null),
    },
  }
}

/**
 * The user's priority, as a configurable chain: usable first, then multimodal,
 * then the lowest measured first-token latency, then the longer context, then the
 * larger output cap; ties break deterministically by provider/model (that last
 * step is not a configurable field: without it the list jitters when the chain
 * changes). The field order and each field's on/off flag come from
 * `<DSH_HOME>/free-auto/settings.json`; an empty or unknown chain falls back to
 * the default order.
 */
function compareRows(fields) {
  const active = normalizeFields(fields).filter((field) => field.enabled)
  return (a, b) => {
    for (const field of active) {
      let verdict = 0
      switch (field.key) {
        case 'availability':
          verdict = stateRank(a.state) - stateRank(b.state)
          break
        case 'multimodal':
          if (a.vision !== b.vision) verdict = a.vision ? -1 : 1
          break
        case 'ttft':
          verdict = (a.ttftMs ?? NO_TTFT) - (b.ttftMs ?? NO_TTFT)
          break
        case 'context':
          verdict = (b.contextWindow ?? -1) - (a.contextWindow ?? -1)
          break
        case 'maxTokens':
          verdict = (b.maxTokens ?? -1) - (a.maxTokens ?? -1)
          break
        default:
          break
      }
      if (verdict) return verdict
    }
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1
    return a.model < b.model ? -1 : a.model > b.model ? 1 : 0
  }
}

/**
 * 子智能体的取模规则：在"已探测的非首位模型"里随机挑一个（只保留首 token 延迟
 * 不超过最优模型 maxTtftFactor 倍的；任一侧没有延迟数据就不设限）。没有候选就
 * 退化到未探测模型里随机，再不行才用最优模型。纯函数，便于测试。
 */
export function chooseSubagentTarget(rows, { maxTtftFactor = 5 } = {}, random = Math.random) {
  if (!Array.isArray(rows) || !rows.length) return null
  const best = rows[0]
  const probed = rows.filter((row) => row.state !== 'unknown')
  const nonBest = probed.filter((row) => row !== best)
  const bestTtft = Number.isFinite(best.ttftMs) ? best.ttftMs : null
  const within = nonBest.filter((row) => {
    const ttft = Number.isFinite(row.ttftMs) ? row.ttftMs : null
    if (bestTtft === null || ttft === null) return true
    return ttft <= bestTtft * maxTtftFactor
  })
  const pick = (pool) => pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]
  if (within.length) return pick(within)
  const unprobed = rows.filter((row) => row.state === 'unknown')
  if (unprobed.length) return pick(unprobed)
  return best
}

/** 把用户选的思考档位投影到目标模型自己的阶梯上（不支持的档位不会硬塞给它）。 */
function projectEffort(row, requested) {
  const wanted = String(requested ?? '')
  if (!wanted) return undefined
  const efforts = Array.isArray(row?.reasoning?.efforts) ? row.reasoning.efforts : []
  if (!efforts.length) return undefined
  if (efforts.some((effort) => effort.id === wanted)) return wanted
  if (effortRank(wanted) <= 0) {
    const off = efforts.find((effort) => effortRank(effort.id) <= 0)
    return off ? String(off.id) : undefined
  }
  const atOrBelow = efforts.filter((effort) => effortRank(effort.id) <= effortRank(wanted))
  const pool = atOrBelow.length ? atOrBelow : efforts
  const chosen = pool.reduce((best, effort) => {
    if (!best) return effort
    if (atOrBelow.length) return effortRank(effort.id) >= effortRank(best.id) ? effort : best
    return effortRank(effort.id) <= effortRank(best.id) ? effort : best
  }, null)
  return chosen ? String(chosen.id) : undefined
}

/** 首 chunk 看门狗：一段时间没有任何 chunk 就中止并报 TIMEOUT（会被当作可切换失败）。 */
async function* guard(source, timeoutMs, onTimeout) {
  const iterator = source[Symbol.asyncIterator]()
  try {
    for (;;) {
      let timer
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(STALLED), timeoutMs)
      })
      const next = await Promise.race([iterator.next(), timeout])
      clearTimeout(timer)
      if (next === STALLED) {
        onTimeout?.()
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: 'TIMEOUT',
              message: `free-auto: ${Math.round(timeoutMs / 1000)}s 内没有任何输出，换一个模型`,
            },
          },
        }
        return
      }
      if (next.done) return
      yield next.value
    }
  } finally {
    try {
      await iterator.return?.()
    } catch {
      // the upstream iterator is already gone
    }
  }
}

class ModelCatalog {
  constructor(ctx, settings, sortStore) {
    this.ctx = ctx
    this.settings = settings
    this.sortStore = sortStore
    this.logger = ctx.logger ?? console
    this.fields = sortStore.current()
    this.cache = { at: 0, rows: [], hidden: [], fields: this.fields, revision: sortStore.revision }
    this.walking = null
  }

  /** The routes to read, configured ones first (and only those by default). */
  async routes() {
    const routes = [...this.settings.sourceRoutes]
    if (!this.settings.includeAllProviders) return routes
    try {
      const providers = (await this.ctx.llm.listProviders?.()) ?? []
      for (const provider of providers) {
        const id = String(provider?.id ?? '')
        if (id && !routes.includes(id) && id !== ROUTE) routes.push(id)
      }
    } catch (error) {
      this.logger.warn?.(`[free-auto] listProviders failed: ${message(error)}`)
    }
    return routes
  }

  /**
   * The ranked rows. Cheap by construction: an in-memory catalog walk plus two
   * small JSON reads, reused for candidateTtlMs and shared while one walk is
   * already in flight. The sort settings live in memory (SortSettingsStore), so
   * a POSTed change costs nothing here beyond a re-walk of the cached walk.
   */
  async collect({ fresh = false } = {}) {
    const now = Date.now()
    if (
      !fresh &&
      this.cache.at &&
      now - this.cache.at < this.settings.candidateTtlMs &&
      this.cache.revision === this.sortStore.revision
    ) {
      return this.cache.rows
    }
    // 非 fresh 的并发请求共用"正在走"的那一次；fresh（POST /settings 之后）必须
    // 排在它后面再走一次——否则会把启动时那次用旧排序链走出来的结果当成新的。
    if (!fresh && this.walking) return this.walking
    const previous = this.walking
    const run = (async () => {
      if (previous) await previous.catch(() => {})
      return this.walk()
    })()
    const walking = run.finally(() => {
      if (this.walking === walking) this.walking = null
    })
    this.walking = walking
    return walking
  }

  async walk() {
    const usable = []
    const hidden = []
    const seen = new Set()
    const hiddenStates = new Set(this.settings.hideStates)
    const fields = this.sortStore.current()
    // 走列表要跨好几个 await：这期间链可能被改（POST /settings）。缓存必须记下
    // "这些行是用哪个 revision 的链走出来的"，而不是收尾时的 revision——否则一份
    // 旧链的行会被当成新链的新鲜缓存，下一次 collect 直接复用它。
    const revision = this.sortStore.revision
    const compare = compareRows(fields)
    const verdicts = readAvailability(this.logger)
    const stats = readStats(this.logger)
    for (const route of await this.routes()) {
      let models = []
      try {
        models = (await this.ctx.llm.listModels(route)) ?? []
      } catch {
        // an unknown or currently empty route contributes nothing
        continue
      }
      for (const model of models) {
        const id = String(model?.id ?? '')
        if (!id) continue
        const key = `${route}\u0000${id}`
        if (seen.has(key)) continue
        seen.add(key)
        // The region lane only carries names that the egress refused, so a row
        // on it counts as region-blocked even when the probe file is missing.
        const verdict = verdicts.get(id)
        const state = verdict?.state ?? (route === REGION_ROUTE ? 'region-blocked' : 'unknown')
        let info = model
        try {
          info = { ...model, ...(await this.ctx.llm.resolveModelInfo(route, id)) }
        } catch {
          // keep the listModels row when the detail call fails
        }
        const row = describe(route, id, info, state, verdict, stats.get(id))
        if (hiddenStates.has(state)) hidden.push(row)
        else usable.push(row)
      }
    }
    const rows = usable.sort(compare)
    const folded = hidden.sort(compare)
    this.fields = fields
    this.cache = { at: Date.now(), rows, hidden: folded, fields, revision }
    return rows
  }

  /** What the current session is on, as far as the harness will say. */
  current() {
    try {
      const selection = this.ctx.get?.('agentDefaultModel')?.currentSelection?.()
      if (!selection) return null
      const effort = selection.reasoningEffort === undefined ? '' : String(selection.reasoningEffort)
      return {
        provider: String(selection.provider ?? ''),
        model: String(selection.model ?? ''),
        ...(effort ? { reasoningEffort: effort } : {}),
      }
    } catch {
      return null
    }
  }

  /**
   * Synchronous, I/O-free view over the last walk: the HTTP handler must never
   * hold a response open waiting on a catalog read (an earlier revision of this
   * plugin held SSE connections open and starved the browser's connection pool).
   */
  snapshot(rows = this.cache.rows, folded = this.cache.hidden, extra = {}) {
    // 改动排序链后（POST /settings）缓存会失效；这里再按当前链同步重排一次，
    // 保证这个同步接口给出的名次也跟得上，而且不用 await 任何东西。
    const fields = this.sortStore.current()
    if (fields !== this.cache.fields) {
      rows = [...rows].sort(compareRows(fields))
      folded = [...folded].sort(compareRows(fields))
      this.fields = fields
      // 这里只是把**老行**按新链同步重排，没有重走目录、也没有重读探测文件：
      // 所以 cache.revision 必须保持"这些行是用哪条链走出来的"那个旧值，
      // 否则下一次 collect 会以为缓存很新鲜，直接复用这批旧行。
      //
      // 隐式不变式（别在不知情的情况下改坏它）：一次走列表走的途中链被改过时，
      // 收尾写回的 cache 里 fields/rows/hidden 是**旧链 + 旧探测**那一份，而
      // sortStore.current() 已经是新链——于是"cache.fields ≠ 当前链"与
      // "cache.revision ≠ sortStore.revision"会同时成立，这一小段时间里
      // cache 内部并不自洽。出口有两道：collect 里对 cache.revision 的判等
      // 负责让它整体作废、重走；snapshot 这里用前重排负责让同步接口仍然按新链
      // 出正确名次。两道只要少一道，旧行就会被当成新链的结果发出去。
      this.cache = { ...this.cache, rows, hidden: folded, fields }
    }
    return {
      ok: true,
      updatedAt: this.cache.at || null,
      sources: this.settings.sourceRoutes,
      hideStates: [...this.settings.hideStates],
      sortFields: fields.map((field) => ({ ...field })),
      current: this.current(),
      models: rows.map((row, index) => ({ rank: index + 1, ...row })),
      hiddenModels: folded,
      ...extra,
    }
  }
}

/** Auto-Free：选举、冷却、透明重试，全部发生在自己注册的这条路由内部。 */
class AutoFreeAdapter {
  constructor(ctx, catalog, settings) {
    this.ctx = ctx
    this.catalog = catalog
    this.settings = settings
    this.logger = ctx.logger ?? console
    /** sessionId → { provider, model, at, name }：会话内锁定。 */
    this.elections = new Map()
    /** `${provider}\0${model}` → 冷却截止时间（`\0*` 表示整条线路）。 */
    this.cooling = new Map()
  }

  providerInfo(provider) {
    return { id: provider, name: ROUTE_LABEL }
  }

  /** 沿用来源线路自己的重试策略：RATE_LIMIT 不重试（重试只会多花额度）。 */
  providerRetryPolicy() {
    try {
      return this.ctx.llm.providerRetryPolicy?.(this.settings.sourceRoutes[0])
    } catch {
      return undefined
    }
  }

  imageRequestPricing() {
    return undefined
  }

  /** 会话里保存的思考档位（用来保证它在本路由的阶梯里合法）。 */
  savedEffort() {
    try {
      const effort = this.ctx.get?.('agentDefaultModel')?.currentSelection?.()?.reasoningEffort
      return effort === undefined || effort === null ? '' : String(effort)
    } catch {
      return ''
    }
  }

  /** 本路由广告的思考阶梯：候选模型阶梯的并集，外加会话里已保存的那一档。 */
  ladder(rows) {
    const seen = new Map()
    for (const row of rows) {
      for (const effort of row.reasoning?.efforts ?? []) {
        if (effort?.id && !seen.has(effort.id)) {
          seen.set(effort.id, { id: String(effort.id), name: String(effort.name ?? effort.id) })
        }
      }
    }
    const ladder = [...seen.values()].sort((a, b) => effortRank(a.id) - effortRank(b.id))
    const saved = this.savedEffort()
    if (saved && !seen.has(saved)) ladder.push({ id: saved, name: saved })
    return ladder
  }

  /** 这条虚拟模型的元数据（dsh-llm 会校验 context/defaultMaxTokens/efforts）。 */
  describe(rows) {
    const best = rows[0]
    const ladder = this.ladder(rows)
    const listed = ladder.length ? ladder : [AUTOMATIC]
    const own = best?.reasoning?.defaultEffort === undefined ? '' : String(best.reasoning.defaultEffort)
    const defaultEffort = listed.some((effort) => effort.id === own) ? own : String(listed[0]?.id ?? 'auto')
    const window =
      Number.isSafeInteger(best?.contextWindow) && best.contextWindow > 0 ? best.contextWindow : FALLBACK_CONTEXT
    const output = Number.isSafeInteger(best?.maxTokens) && best.maxTokens > 0 ? best.maxTokens : FALLBACK_MAX_TOKENS
    return {
      provider: ROUTE,
      id: AUTO_MODEL,
      name: AUTO_NAME,
      description: best ? `自动路由到列表最上方：当前 → ${best.name}` : '自动路由（当前没有可用模型）',
      inputModalities: rows.some((row) => row.vision) ? ['text', 'image'] : ['text'],
      context: { contextWindow: window },
      defaultMaxTokens: output,
      reasoning: { efforts: listed, defaultEffort },
    }
  }

  async listModels() {
    const rows = await this.catalog.collect()
    // 没有候选就广告 0 个模型：模型选择器不会出现空的 Auto-Free 分组。
    return rows.length ? [this.describe(rows)] : []
  }

  async resolveModel() {
    return this.describe(await this.catalog.collect())
  }

  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: (options) => this.stream(options) }
  }

  isSubagent(sessionId) {
    if (!sessionId) return false
    try {
      return this.ctx.get?.('sessions')?.subagentAddress?.(sessionId) !== undefined
    } catch {
      return false
    }
  }

  /** 冷却中的模型先排除；全都冷却时就照旧用（总比没有好）。 */
  usable(rows) {
    const now = Date.now()
    const fresh = rows.filter((row) => (this.cooling.get(targetKey(row)) ?? 0) <= now)
    return fresh.length ? fresh : rows
  }

  remember(sessionId, row) {
    if (sessionId && row) {
      this.elections.set(sessionId, { provider: row.provider, model: row.model, name: row.name, at: Date.now() })
    }
    return row
  }

  /** 会话内不切换：已有选举且它还在列表里就继续用它，否则选列表最上方那个。 */
  elect(sessionId, rows) {
    const existing = sessionId ? this.elections.get(sessionId) : null
    if (existing) {
      const row = rows.find((entry) => entry.provider === existing.provider && entry.model === existing.model)
      if (row) return row
      // 选举的模型从列表里消失了（例如被判定不可用）：重新选举。
      this.elections.delete(sessionId)
    }
    return this.remember(sessionId, rows[0])
  }

  pickSubagent(sessionId, rows) {
    const existing = sessionId ? this.elections.get(sessionId) : null
    if (existing) {
      const row = rows.find((entry) => entry.provider === existing.provider && entry.model === existing.model)
      if (row) return row
      this.elections.delete(sessionId)
    }
    if (!this.settings.subagent.avoidBest) return this.remember(sessionId, rows[0])
    const chosen = chooseSubagentTarget(rows, this.settings.subagent)
    return this.remember(sessionId, chosen ?? rows[0])
  }

  /** 失败后换一个：剔除已经试过的，重新选举（子智能体继续走避让规则）。 */
  next(rows, attempted, sessionId, subagent) {
    const pool = this.usable(rows).filter((row) => !attempted.has(targetKey(row)))
    if (!pool.length) return null
    if (sessionId) this.elections.delete(sessionId)
    if (subagent && this.settings.subagent.avoidBest) {
      return this.remember(sessionId, chooseSubagentTarget(pool, this.settings.subagent) ?? pool[0])
    }
    return this.remember(sessionId, pool[0])
  }

  /** 冷却这个模型（地区受限则整条线路），并清掉本会话的选举，让下一条消息重新选举。 */
  cool(row, failure, sessionId) {
    const until = Date.now() + this.settings.cooldownMs
    this.cooling.set(targetKey(row), until)
    if (String(failure?.code ?? '').toUpperCase().includes('REGION')) {
      this.cooling.set(`${row.provider}\u0000*`, until)
    }
    if (sessionId) this.elections.delete(sessionId)
    this.logger.warn?.(
      `[free-auto] ${row.provider}/${row.model} 冷却 ${Math.round(this.settings.cooldownMs / 1000)}s（${
        failure?.code ?? 'FAILURE'
      }）`,
    )
  }

  /** Auto-Free 的核心：选举 → 转发 → 失败则冷凝重扫重试，会话不中断。 */
  async *stream(options) {
    const sessionId = String(options?.sessionId ?? '')
    const subagent = this.isSubagent(sessionId)
    let rows = this.usable(await this.catalog.collect())
    if (!rows.length) {
      throw Object.assign(new Error(NO_FREE_MODEL_MESSAGE), { code: 'NO_FREE_MODEL' })
    }
    let target = subagent ? this.pickSubagent(sessionId, rows) : this.elect(sessionId, rows)
    const attempted = new Set()
    const maxAttempts = this.settings.retry.maxAttempts
    const timeoutMs = this.settings.retry.firstChunkTimeoutMs
    let failure = null

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (!target) {
        yield finishChunk(failure)
        return
      }
      attempted.add(targetKey(target))
      const abort = new AbortController()
      const forwarded = { ...options, provider: target.provider, model: target.model }
      const effort = projectEffort(target, options?.reasoningEffort)
      if (effort === undefined) delete forwarded.reasoningEffort
      else forwarded.reasoningEffort = effort
      forwarded.signal = options?.signal
        ? typeof AbortSignal.any === 'function'
          ? AbortSignal.any([options.signal, abort.signal])
          : options.signal
        : abort.signal

      failure = null
      let emitted = false
      const upstream = this.ctx.llm.stream(forwarded)
      const source = timeoutMs > 0 ? guard(upstream, timeoutMs, () => abort.abort()) : upstream
      try {
        for await (const chunk of source) {
          if (chunk?.type === 'finish') {
            if (chunk.reason?.failure) {
              failure = chunk.reason.failure
              break
            }
            // 正常收尾：原样交给上层（它带着 usage 与结束原因，不能吞）。
            yield chunk
            return
          }
          if (chunk?.type === 'text' || chunk?.type === 'reasoning' || chunk?.type === 'tool') emitted = true
          yield chunk
        }
      } catch (error) {
        failure = { message: message(error), code: String(error?.code ?? 'TRANSPORT') }
      }
      if (!failure) return

      const code = String(failure.code ?? '').toUpperCase()
      const switchable = this.settings.switchCodes.includes(code)
      const canRetry = switchable && !emitted && attempt + 1 < maxAttempts && !options?.signal?.aborted
      if (!canRetry) {
        // 已经吐过内容、或这轮不想再换：把失败原样交给上层。
        yield finishChunk(failure)
        return
      }
      this.cool(target, failure, sessionId)
      // "自动刷新列表"：跳过缓存重扫，availability/stats 都是这一步重新读的。
      rows = this.usable(await this.catalog.collect({ fresh: true }))
      target = this.next(rows, attempted, sessionId, subagent)
    }
  }

  /** 给 HTTP 路由/测试看的现状。 */
  status() {
    const now = Date.now()
    return {
      ok: true,
      route: ROUTE,
      model: AUTO_MODEL,
      elections: [...this.elections].map(([sessionId, value]) => ({ sessionId, ...value })),
      cooldowns: [...this.cooling].map(([key, until]) => ({ key, until, remainingMs: Math.max(0, until - now) })),
    }
  }
}

function finishChunk(failure) {
  return {
    type: 'finish',
    reason: failure
      ? { kind: 'error', failure }
      : { kind: 'error', failure: { code: 'NO_FREE_MODEL', message: NO_FREE_MODEL_MESSAGE } },
  }
}

// --- Plugin entry ---------------------------------------------------------

export function apply(ctx, config) {
  const settings = resolveSettings(config)
  const logger = ctx.logger ?? console
  const sortStore = new SortSettingsStore(logger, lazyFs(ctx))
  const catalog = new ModelCatalog(ctx, settings, sortStore)
  const adapter = new AutoFreeAdapter(ctx, catalog, settings)

  ctx.effect(() => {
    void catalog.collect().catch((error) => logger.warn?.(`[free-auto] initial list failed: ${message(error)}`))
    return () => {}
  }, 'free-auto: warm the model list')

  if (settings.autoFree) {
    ctx.effect(() => {
      let registration
      try {
        registration = ctx.llm.registerAdapter([ROUTE], adapter)
      } catch (error) {
        logger.warn?.(`[free-auto] could not register the "${ROUTE}" route: ${message(error)}`)
        return () => {}
      }
      logger.info?.(
        `[free-auto] "${ROUTE}" route ready (auto-routes to the top of the list; switching on ${settings.switchCodes.join(
          '/',
        )})`,
      )
      return () => {
        try {
          registration?.()
        } catch {
          // already released
        }
      }
    }, 'free-auto: auto route')
  }

  ctx.provide?.('free-auto', {
    models: () => catalog.snapshot(),
    refresh: () => catalog.collect({ fresh: true }),
    status: () => adapter.status(),
    sortFields: () => sortStore.current().map((field) => ({ ...field })),
    saveSortFields: (fields) => sortStore.save(fields),
  })

  const json = (req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
  const plain = (res, status, text) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(text)
  }
  /** 落盘失败：给客户端一段能直接显示的错误文本（面板的 error 面）。 */
  const failureResponse = (res, error) => {
    const text = `free-auto: 保存排序设置失败：${message(error)}`
    logger.warn?.(`[free-auto] ${text}`)
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  }
  /**
   * 设置体本来就很小（5 个字段），所以给它一个硬上限：超了立刻停止读取并回 413，
   * 不把几十 MB 读进内存再让 JSON.parse 去踩。剩下的字节不再由这里消费。
   */
  const MAX_SETTINGS_BODY = 64 * 1024
  const readBody = async (req, limit = MAX_SETTINGS_BODY) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buf.length
      if (size > limit) {
        const error = new Error(`free-auto: 请求体超过 ${limit} 字节上限`)
        error.code = 'BODY_TOO_LARGE'
        throw error
      }
      chunks.push(buf)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  const settingsBody = () => {
    const described = sortStore.describe()
    return JSON.stringify({ ...described, updatedAt: catalog.cache.at || null })
  }
  /**
   * 落盘 + 立刻让新排序生效。`{fields:[…]}` 自定义排序链，`{reset:true}` 恢复默认；
   * 两者都走同一次归一化，因此任何输入都会收敛成合法的 5 字段排列。
   * 形状对但内容不可用（空数组 / 一个已知 key 都没有）算 400：客户端永远发 5 项全量，
   * 所以这只会是手写请求出错，静默落回默认会让调用方以为设置生效了。
   * 缺少 `fields`/`reset` 成员（`{"version":1}`、`null`、数组……）同样是**调用方**的错误，
   * 也走 400；500 只留给"形状没问题、磁盘写不进去"那一种（见 failureResponse）。
   */
  const badInput = (text) => Object.assign(new Error(text), { status: 400 })
  const saveSettings = async (input) => {
    const body = input && typeof input === 'object' ? input : {}
    if (body.reset === true) {
      sortStore.save(undefined)
    } else if (Array.isArray(body.fields)) {
      const known = body.fields.filter(
        (entry) => entry && typeof entry === 'object' && SORT_KEYS.includes(String(entry.key ?? '')),
      )
      if (!known.length) {
        throw badInput(`free-auto: fields 里没有任何已知的排序字段（可选 ${SORT_KEYS.join(' / ')}）；恢复默认请用 {reset:true}`)
      }
      sortStore.save(body.fields)
    } else {
      throw badInput('free-auto: 需要 {fields:[…]} 或 {reset:true}')
    }
    // 排序链变了：立刻重扫，并让 Auto-Free 的选举用同一份新列表。
    const rows = await catalog.collect({ fresh: true })
    return JSON.stringify(catalog.snapshot(rows, catalog.cache.hidden, { settings: sortStore.describe() }))
  }
  const snapshotBody = async (fresh, sessionId) => {
    try {
      const rows = await catalog.collect({ fresh })
      const election = sessionId ? adapter.elections.get(sessionId) : null
      const auto = settings.autoFree
        ? {
            provider: ROUTE,
            model: AUTO_MODEL,
            name: AUTO_NAME,
            available: rows.length > 0,
            ...(election ? { elected: { provider: election.provider, model: election.model, name: election.name } } : {}),
          }
        : null
      return JSON.stringify(catalog.snapshot(rows, catalog.cache.hidden, { auto }))
    } catch (error) {
      return JSON.stringify({ ok: false, error: message(error), models: [], hiddenModels: [], auto: null })
    }
  }

  ctx.inject(['webServer'], (scoped) => {
    const sessionOf = (req) => {
      try {
        return new URL(String(req?.url ?? '/'), 'http://localhost').searchParams.get('sessionId') ?? ''
      } catch {
        return ''
      }
    }

    const modelsRoute = async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        plain(res, 405, 'method not allowed')
        return
      }
      json(req, res, await snapshotBody(false, sessionOf(req)))
    }

    const refreshRoute = async (req, res) => {
      if (req.method !== 'POST') {
        plain(res, 405, 'method not allowed')
        return
      }
      json(req, res, await snapshotBody(true, sessionOf(req)))
    }

    /**
     * 排序设置：GET/HEAD 读当前生效的排序链（+ 默认链，供面板渲染），
     * POST 落盘 `{fields:[…]}` 或 `{reset:true}` 并返回重排后的列表；
     * 其它方法 405，空 body / 坏 JSON / 内容不可用 400，请求体超限 413，
     * 写盘失败 500 + 可读错误文本。
     */
    const settingsRoute = async (req, res) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        json(req, res, settingsBody())
        return
      }
      if (req.method !== 'POST') {
        plain(res, 405, 'method not allowed')
        return
      }
      let text
      try {
        text = await readBody(req)
      } catch (error) {
        if (error?.code === 'BODY_TOO_LARGE') {
          logger.warn?.(`[free-auto] ${message(error)}`)
          plain(res, 413, `free-auto: 请求体过大（上限 ${MAX_SETTINGS_BODY} 字节）`)
          // 读已经停了；把剩下的字节排掉（resume = 丢弃而非缓冲），别让连接半开着
          try {
            req.resume?.()
          } catch {
            /* 流已经结束了 */
          }
          return
        }
        plain(res, 400, 'free-auto: 读取请求体失败')
        return
      }
      if (!text.trim()) {
        plain(res, 400, 'free-auto: 请求体是空的（需要 {fields:[…]} 或 {reset:true}）')
        return
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        plain(res, 400, 'free-auto: 请求体不是合法 JSON')
        return
      }
      try {
        json(req, res, await saveSettings(parsed))
      } catch (error) {
        if (error?.status === 400) {
          logger.warn?.(`[free-auto] ${message(error)}`)
          plain(res, 400, message(error))
          return
        }
        failureResponse(res, error)
      }
    }

    scoped.effect(() => {
      const disposers = []
      try {
        disposers.push(scoped.webServer.register({ kind: 'exact', path: MODELS_PATH, handler: modelsRoute }))
        disposers.push(scoped.webServer.register({ kind: 'exact', path: REFRESH_PATH, handler: refreshRoute }))
        disposers.push(scoped.webServer.register({ kind: 'exact', path: SETTINGS_PATH, handler: settingsRoute }))
      } catch (error) {
        logger.warn?.(`[free-auto] could not mount ${MODELS_PATH}: ${message(error)}`)
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {
            // nothing left to release
          }
        }
        return
      }
      logger.info?.(
        `[free-auto] model list ready at ${MODELS_PATH} (sources: ${
          settings.sourceRoutes.join(', ') || 'none'
        }; folding: ${settings.hideStates.join(', ') || 'nothing'}; sort: ${
          sortStore
            .current()
            .filter((field) => field.enabled)
            .map((field) => field.key)
            .join(' > ') || 'name only'
        })`,
      )
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {
            // already released
          }
        }
      }
    }, 'free-auto: model list routes')
  })
}