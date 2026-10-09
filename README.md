# dsh-free-auto — Auto-Free 自动路由 + 模型速切

把 `dsh-our-free-model` 当前可用的免费模型**排好序**列出来，
在会话页右下角放一个不显眼的悬浮按钮：点开列表、点模型名就切换当前会话的模型；
列表最上方的 **Auto-Free** 则由插件替你自动挑（挑的就是列表第一名）。

> 演进过程：最早是个纯自动路由插件（在模型选择器里塞两个虚拟模型），发现「自动挑中的模型首 token
> 延迟很长时用户只能干等」⇒ 改成只排序、不代选。现在按需求把自动选择请了回来，但只保留**一行**
> Auto-Free：它永远等于列表第一名，会话内锁定，撞上限流/额度自动换下一个，子智能体则避开最优模型。

## Auto-Free 自动路由

模型选择器（以及本插件的悬浮面板）里会看到 provider `free-auto` / model `auto-free` 这一个虚拟模型，
名字就是 **Auto-Free**。它不是真正调用谁，而是 `index.js` 里注册的一个适配器（`AutoFreeAdapter`）：

- **选举**：每条会话第一次请求时，选中"当前排序后的列表第一名"（`available` 里首字延迟最低的那个，
  见下面的排序规则），把结果记在 `sessionId → {provider, model}` 里；
- **会话内锁定**：同一个会话的第二条、第三条消息继续用同一个模型，即使列表头已经变了（新模型出现、
  探测值刷新都不影响）；只有该模型从可用列表里消失（比如被判成 `throttled`）时才重新选举；
- **限流/额度自动续跑**：若上游返回的失败码在 `switchCodes` 里（默认 `RATE_LIMIT`、`QUOTA`、
  `QUOTA_EXCEEDED`、`REGION_BLOCKED`、`LANE_LOCKED`、`TIMEOUT`），且**这一轮还没有吐出任何内容**
  （没有 text/reasoning/tool chunk，已经吐过就绝不换，否则会把半截回答接到另一个模型上），
  适配器会：把那个模型冷却 `cooldownMs`（默认 10 分钟，地区受限整条线路一起冷却）→ **跳过缓存重扫列表**
  （重新读 `availability.json` / `stats.json`，等于"自动刷新列表"）→ 换下一个可用模型重试同一轮请求。
  整个过程用户看不见，会话不中断、不用重发消息；
- **重试上限**：`retry.maxAttempts`（默认 3，硬上限 5），且同一个模型不会在一轮里被试两遍；
- **首字看门狗**：`retry.firstChunkTimeoutMs`（默认 120000，`0` = 关闭）内一个 chunk 都没等到，
  就按 `TIMEOUT` 处理（即换下一个模型），避免"选举到一个卡住的模型就只能干等"；
- **思考档位投影**：会话里保存的档位在目标模型上不存在时按排名降级（请求 `deep`、目标只到 `balanced`
  就发 `balanced`；`off`/`none` 只在目标模型真的声明了关闭档时才发，否则整个字段不传）；
  不传时由 dsh-llm 用目标模型自己的 `defaultEffort` 补全；
- **子智能体避让**（`subagent.avoidBest`，默认开）：`sessions.subagentAddress(sessionId)` 能认出的
  子代理会话不走"列表第一名"，而是：
  1. 在**已探测且非首位**的模型里随机挑一个，只要求它的首字延迟 ≤ 最优模型的 `subagent.maxTtftFactor`
     倍（默认 5；任何一侧没有延迟数据时不设限）；
  2. 如果只有一个已探测模型（没有可挑的非首位）⇒ 在**未探测**模型里随机挑；
  3. 还没有 ⇒ 退回使用最优模型。
  子代理会话同样会话内锁定；重试换模型时仍然走这套避让规则，不会偷偷回落到最优模型；
- **可观测**：`ctx.get('free-auto').status()`（也是 `ctx.provide` 出去的句柄）返回
  `{ok, route, model, elections:[{sessionId, provider, model, name, at}], cooldowns:[{key, until, remainingMs}]}`；
  悬浮面板里 Auto-Free 那一行会显示「自动路由 · 当前 → <模型名>」。

## 它做什么

宿主半身（`index.js`）

- 读取来源路由的模型表：`ctx.llm.listModels(route)` + `ctx.llm.resolveModelInfo(route, model)`（都是内存调用）；
- 读取 `$DSH_HOME/our-free-model/availability.json`（只读、尽力而为）判断每个模型的**可用性**与
  最近一次探测的首 token 延迟 / 往返延迟 / 探测时间：LLM 目录接口不带这些字段，而限流的模型仍然
  是主线路成员，不看这个文件就分不出「限流」；读不到就当作「未探测」，只按线路判断（region 线路一律算地区受限）；
- 读取同一目录的 `stats.json`（只读、尽力而为）算出**真实请求测出的平均首 token 延迟**与解码速度
  （按天累加 `ttftMs/ttftSamples`、`decodeTokens/decodeMs`；顶层 `models[id]` 只有 token 计数，不能用）：
  探测值可能已经过时，均值更有代表性，排序优先用它；
- 按 **可用 → 多模态 → 首 token 延迟低 → 上下文长 → 输出上限大** 排序，并列时按 `route`/`model`
  决定，结果稳定；限流 / 地区受限 / 不可用 的模型默认**不进主列表**，而是折叠在 `hiddenModels` 里
  （`hideStates` 可调）；
- 通过 `GET /api/free-auto/models` 返回 JSON（`HEAD` 也支持，其它方法 405），
  `POST /api/free-auto/refresh` 强制重扫（跳过缓存）；响应永不等待上游目录（10s 缓存 + 单次并发合并），
  避免占住浏览器连接；
- 注册 provider 路由 `free-auto`，只广告 `auto-free` 一个模型（见上一节）；没有可用候选时它广告
  **0 个**模型，模型选择器里就不会出现空的 Auto-Free 分组。列表本身永远来自上游真实目录，
  上游换模型表不需要改这个插件。

客户端半身（`client.js`，由 ModuleLoader 直接加载，无打包步骤）

- 挂载在 `conversation.input.overlay`（`kind: list` / `scope: session`），拿插槽传入的 `sessionId`；
- 右下角 `position: fixed` 悬浮按钮 → 点开是排好序的列表，**第一行是 Auto-Free**（下面一条分隔线），
  其余每行是名次、名称、可用性、视觉/纯文本、**首字延迟**、上下文、输出上限、**探测时间**、思考档位数，
  底部脚注写明排序依据与当前被折叠的状态；
- Auto-Free 那一行显示「自动路由 · 当前 → <模型名>」（该会话已经选举过时）或
  「自动路由到列表最上方 · 会话内锁定」；点它即把会话切到 `free-auto/auto-free`；
- **折叠组**：不可用 / 限流 / 地区受限的模型默认收在「展开 N 个不可用模型」下面，展开后每行显示
  状态、不可用原因（如 `Model … has been deprecated.`）、多久前探测的、以及最近的调用/失败次数；
- **重新探测**按钮：调用子插件自己的 `POST /api/our-free-model/reprobe`（浏览器同源请求能过它的
  trust fence），再隔几次 `POST /api/free-auto/refresh` 打掉缓存重读，直到结果稳定；期间按钮显示「探测中…」；
- 列表有三种自动收回方式：**点击面板外任意位置**、按 `Esc`、以及**鼠标移出控件 0.65s 后**仍未移回
  （留出从按钮移到面板那几像素缝隙的时间；移回即取消，成功切换后也会立即收回）；
- 点某个模型名调用 DSH 自带的 Remote：`ctx.remote.session.selectModel({ sessionId, provider, model })`
  —— 和内置模型选择器同一条路径（写入会话的 `model/selection` 事件，下一次请求生效，并同步为该部署默认模型）；
- **故意不传 `reasoningEffort`**：宿主会用目标模型自己的 `defaultEffort` 补全，因此不会出现
  "当前全局档位在目标模型上不存在" 导致的 `UNSUPPORTED_REASONING_EFFORT` 拒绝；
- 当前模型带「当前」标记，来自会话的 `modelSelection` 投影（内置选择器改了也会同步）；
- 子代理会话不显示（与内置选择器的可用性判断一致）；主列表和折叠组都为空时整个控件隐藏。

## 排序规则

| 优先级 | 依据 | 说明 |
| --- | --- | --- |
| 1 | 可用性 | `available` > `unknown` > `throttled` > `region-blocked` > `unavailable`；后三种默认折叠 |
| 2 | 多模态 | 支持图片的排在纯文本前面 |
| 3 | 首 token 延迟小 | 实测均值优先，其次最近一次探测值；都没有的排在有数据的后面 |
| 4 | `contextWindow` 大 | 上下文窗口越大越靠前 |
| 5 | `defaultMaxTokens` 大 | 输出上限越大越靠前 |
| 6 | `provider` / `model` | 前面都相同时按名字定序，保证列表稳定 |

Auto-Free 选举用的就是这份顺序的第一名（子智能体除外，见上）。

## 配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `sourceRoutes` | `['our-free-model','our-free-model-region']` | 列出这些路由上的模型 |
| `candidateTtlMs` | `10000` | 列表复用时长；`0` = 每次请求都重读上游目录 |
| `includeAllProviders` | `false` | 连同 DSH 已知的其它 provider 一起列出 |
| `hideStates` | `['unavailable','throttled','region-blocked']` | 这些可用性状态的模型折叠进 `hiddenModels`；`[]` = 全都并列出来（仍带状态标记并排在可用模型后面） |
| `autoFree` | `true` | 是否注册 `free-auto` / `auto-free` 这条虚拟路由；关掉就只剩排序 + 速切 |
| `switchCodes` | `['RATE_LIMIT','QUOTA','QUOTA_EXCEEDED','REGION_BLOCKED','LANE_LOCKED','TIMEOUT']` | 出现这些失败码时冷却并换模型重试；不在表里的（如 `SERVER`/`ABORTED`）原样上抛、不换 |
| `cooldownMs` | `600000` | 被换掉的模型冷却多久（10 分钟） |
| `retry.maxAttempts` | `3` | 一轮请求最多尝试几个模型（硬上限 5） |
| `retry.firstChunkTimeoutMs` | `120000` | 首 chunk 看门狗阈值；`0` = 关闭。超时按 `TIMEOUT` 处理（换下一个模型） |
| `subagent.avoidBest` | `true` | 子代理会话避开最优模型（`false` = 和主会话一样直接用第一名） |
| `subagent.maxTtftFactor` | `5` | 子代理候选的首字延迟上限 = 最优模型的这个倍数 |

## 已知限制

- 可用性与延迟来自只读 `$DSH_HOME/our-free-model/{availability.json,stats.json}`（由 dsh-our-free-model
  写入）；文件读不到、或换了别的免费来源插件时，就只能按线路 + 静态能力排序（延迟维度自动退化），
  Auto-Free 于是退化成"按可用性与静态能力挑第一名"。
- 探测值可能过期（`probeIntervalMinutes` 默认 15 分钟一轮，撞上配额还会暂停一轮），所以列表里
  同时显示「探测 X 分钟前」和实测均值，别把单次探测值当承诺。
- 列表里的上下文 / 输出上限是**静态能力**，不是实时配额；真被限流时 `selectModel` 的失败信息
  会显示在列表标题处。
- Auto-Free 的选举与冷却都在**内存**里：重启 DSH web 后全会丢，会话会按当时的列表重新选举一次
  （对于自动路由来说这是可接受的行为）。
- Auto-Free 只按失败的**码**判断"限流/额度"：若上游把额度耗尽报成别的码（不在 `switchCodes` 里），
  那一轮不会自动换模型；把码加进 `switchCodes` 即可。
- 子代理识别依赖 `ctx.get('sessions').subagentAddress(sessionId)`；拿不到这个服务（或它认不出）时，
  子代理会退回主会话的行为（用第一名）。
- 「重新探测」只是让子插件立刻跑一轮；它会自己限速，窗口期内可能没有变化。
- 子插件的 `POST /api/our-free-model/reprobe` 走 DSH `connection` 服务的准入判断：同源页面请求通常
  能过，若被拒（401/403/503）按钮会把错误显示在标题处。
- 悬浮按钮用 `position: fixed` 固定在视口右下（离底边 108px，正好在输入框上方）；
  若某个 shell 在祖先生成 `transform`，固定定位会退化成相对该祖先定位。

## 安装 / 更新

- 这个包已以 `link:D:/dsh/plugins/dsh-free-auto` 形式装进 profile，**不要**再执行
  `plugin_manager install_bundle`（会与已有 link 冲突并报 `ambiguous-install`）。
- 改 `index.js`（宿主半身）后需要重启 DSH web 才生效（ESM 按 URL 缓存，禁用/启用不会重新导入）。
- 改 `client.js` 由客户端 HMR 热更新（按文件 mtime 计算版本并推送），刷新页面即可看到。
- 新增/删除客户端半身（`package.json` 的 `dsh.client`、`exports["./client"]`）属于启动图变更，必须重启。

## 验证

```pwsh
cd D:\dsh\plugins\dsh-free-auto
node --check index.js; node --check client.js
node test/smoke.mjs      # 列表 / 排序 / 折叠 / HTTP 载荷 / 客户端静态约定（10 节）
node test/router.mjs     # Auto-Free 路由：选举、锁定、限流换模型、子代理避让（12 节）
```

两个测试都是纯离线测试（假的 `ctx.llm`、假的 `webServer`，直接调用路由处理函数；`DSH_HOME`
指向临时目录，`availability.json` / `stats.json` 由测试自己写）。

- `test/smoke.mjs`（10 节）：注册 Auto-Free 适配器且挂两条路由；排序与元数据（含折叠组）；
  TTL 缓存/同步快照/显式刷新；缺失路由、空目录、详情调用失败时的降级；读路由 GET/HEAD、
  刷新路由只收 POST、其它 405；当前选择（无服务时为 `null`）；`includeAllProviders` 与无思考档模型；
  客户端半身的静态约定（列表路由、Auto-Free 首行、折叠组、重新探测、无 SSE、无输入框徽标、固定定位）；
  可用性折叠与状态序；延迟排序（模态 > 延迟 > 上下文）、实测均值优先于探测值、折叠行的原因与探测时间。
- `test/router.mjs`（12 节）：广告与元数据（并集阶梯、取第一名窗口）；空目录时广告 0 个模型且调用抛
  `NO_FREE_MODEL`；会话内锁定（列表头变了也不跟着变，新会话才用新头）；`RATE_LIMIT` 透明换模型 +
  重扫列表 + 冷却，同一会话继续；`QUOTA_EXCEEDED` 换、`SERVER`/`ABORTED` 不换且选举保留；
  已经吐过内容不再换；重试上限与"不重复试同一个模型"；子代理避让规则（含"只有一个已探测模型"
  与"5 倍之外不合格"的退化路径）；不可用模型进不了列表；首字看门狗换模型；思考档位投影；
  HTTP 载荷里的 Auto-Free 行与该会话的选举。