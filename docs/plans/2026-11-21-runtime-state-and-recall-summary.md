# 当前会话实际状态与本轮召回摘要执行计划

日期 2026-11-21。两项功能已实现并通过本地验收，基线为官方运行时 0.8.8 和 DSH 0.2.2-rc.1。

同日复核了上游发布与宿主接口。实施前和交付前查询 npm latest，均为 0.8.8。冷历史会话查询和正文检索完成后准备阶段取消的语义已纳入实现与回归测试。

本计划由独立 subagent 编写，并结合另外两个 subagent 对 Hindsight TypeScript 运行时、REST 实现及生成 SDK 的调查。交付范围只有两个功能：当前会话实际使用的记忆配置，以及每次自动召回的结果和正文注入状态。

## 1. 目标、边界与实现基线

完成后，用户在尚未发送新消息时，可以查询当前会话是否已有活跃运行时、实际使用哪个 bank 和服务地址、召回模式及频率、会话回写开关、已加载增强版本。发送消息后，可以在现有 Hindsight 活动行中区分未检索、空结果、失败、降级成功、正文待提交与正文已进入上下文。

本次不修改召回策略、请求参数、重试和降级行为，不增加记忆正文浏览编辑、bank 管理、会话回写进度查询、服务端接口、服务端 trace 查询或后台轮询。统计记录不包含用户查询和记忆正文，不增加模型上下文内容。只修改 DSH 观测接入；共享核心代码的可选观测参数未传入时保持其他 harness 的原有行为。

管理器实施基线为 0.4.0，本次交付版本为 0.5.0，目标宿主为 DSH 0.2.2-rc.1。**用户要求跟随最新上游，目标运行时采用实施时 npm latest 对应的官方发布版本。** 本次联网核实 `@vectorize-io/hindsight-coding-agents` 的 latest 为 **0.8.8**，npm 的 gitHead 与 0.8.8 发布提交一致。现有本地 0.8.7 加四补丁只用于迁移行为对照。开始实施时保留已有未提交的 `README.md`、`activity.config.json`、`activity.js`、`tests/activity.test.mjs` 改动，尤其保留反向代理前缀匹配和 `agent/created` 活动归属修复。

Hindsight 官方仓库为 <https://github.com/vectorize-io/hindsight>。发布交付基线为 **0.8.8 / `0a7ed29d705d967fe1f759c542842fa3709c3d43`**，npm 发布时间为 **2026-11-19T13:47:38.392Z**。本次深读 main 固定在 `80bd005fc2be5c9604a1a0c9741ea93d5ac85156`；调研期间 main 继续更新到 `62a03bfc96f175e9ac155acc72f292bed9ac4449`。已核对新增的一个提交只改 knowledge/media.py 及其测试，不影响 coding-agents 和本计划涉及的 API 代码。最新 main 用于检查未发布差异，不代替 npm latest 的发布源码。上述标识用于定位研究版本，不引入任何摘要校验流程。

已直接比较 release 到审阅 main：整个 `hindsight-integrations/coding-agents/` 和 `hindsight-api-slim/hindsight_api/api/http.py` 均无差异，memory_engine.py 有后续变更。因此下述 TypeScript 与 HTTP 证据可固定到当前发布源码；引擎证据注明采用审阅 main，不冒充部署实测。

最新上游仍没有本地四份补丁中的完整 DSH 生命周期、取消、刷新、卸载及逐轮召回行为，因此先将这些既有能力移植到最新发布源码，再实现两项观测。保留最新上游本身的行为，包括其已有的 `preambleOnFirstTurn` 变化，不用旧 RuntimeCore 整段覆盖新源码。旧补丁不可原样应用到 0.8.8。新交付采用 `runtime-patches/0.8.8/source.patch` 与 `delivery.patch`：前者是源码维护依据，后者由构建结果生成，供离线发布包应用。

## 2. 已核实的关键证据

| 证据 | 位置 | 对方案的影响 |
| --- | --- | --- |
| 管理器仅通过声明文件判断增强产物；不检查已加载实例 | `index.js` 的 `readEnhancement()` | 安装声明和当前进程状态分别展示，不能互相证明 |
| 工作区缓存是 `root → workspace/null`；`workspaceFor()` 会解析配置、构造客户端 | 本地运行时 `dist/dsh.js` 的 `createDshRuntime()` | 查询只能读 Map，不能调用 `workspaceFor()` / `workspaceForAgent()` |
| 新会话可能复用同工作区缓存；保存配置不清除该缓存 | 同上；管理器 `save` 路由 | 当前配置由已缓存实例返回，不能拿磁盘设置代替 |
| TypeScript 中 `RuntimeCore` 的 cfg、client、bankId 为 private | 最新上游 `src/core/runtime.ts` | 核心新增窄的只读投影方法，避免管理器读私有字段 |
| `buildHookOutput()` 先构造正文，再刷新页面目录；首轮可能只有目录及工具说明 | 上游 `src/core/hook.ts`、`src/core/runtime.ts` | 单独报告正文是否存在，正文计时排除目录刷新 |
| `recallObservations()` 返回的是 trim/filter 后的字符串；404 被转换为 `[]` | 上游 `src/core/hindsight.ts`，本地 `dist/dsh.js:1257` | “0 条”必须同时知道 HTTP 结果，不能把 404 当检索成功 |
| pages 有 `/pages` 到 `/knowledge-base` 的兼容路径；部分 404 转为空数组 | 同一客户端 `pagesReq()`、`searchPages()` | 记录最终状态及明确的 pages 不可用状态，保持既有兼容流程 |
| reflect 当前只使用文本，未请求 `include.facts` | 同一客户端 `reflect()` | 展示合成文本是否返回和字符数，不显示命中记忆条数 |
| 宿主在 pre-step 返回后仍检查取消，之后才提交 `user/message` | DSH `dsh-agent-loop/lib/index.js:685`、`:842` | 插件产生文本不等于已注入，以已提交消息为证据 |
| `session/event` 在 append 发布期间同步触发，禁止重入 append | DSH `dsh-session/lib/index.js:1576` | 不在该监听内追加注入确认记录；前端直接归并已提交消息 |
| `appendPluginRecord()` 可持久化 JSON，插件记录不进入模型消息 | 管理器 `tests/host.test.mjs`；DSH session 实现 | 复用会话日志承载摘要，无需独立数据库 |
| Web 只加载连续的历史窗口，初次及向前翻页均有限制 | DSH `dsh-api-session-controller/lib/client.js:2164`、`:2502` | 事件必须尽量自包含；缺少前置详情时显示未加载，不能补造 0 |
| 会话 utilities 是 list 插槽，scope 为 session，标准 props 含 sessionId | DSH `dsh-client-ui-conversation/.../slots.d.ts:259`、`dsh-client-ui-session/.../index.d.ts:80` | 当前状态入口放在会话标题，直接使用宿主传入 sessionId |
| `AgentRegistry.get(id)` 只读活跃实例，`ctx.provide/inject` 由 fiber 管理 | DSH `dsh-agent/lib/types/index.js:365`、Cordis `lib/index.js:1384` | GET 不激活旧会话；服务出现、卸载时自动连接和清理 |

现有 `tests/fixtures/api-contract-1.2.3.json` 仅覆盖 bank 列表和部分 RecallRequest 参数，未覆盖 RecallResponse、ReflectResponse 和 pages 响应。本计划没有把最新 SDK 能力当作部署版本 1.2.3 已验证能力。

上游固定源码参考：

- [当前交付基线的包清单](https://github.com/vectorize-io/hindsight/blob/0a7ed29d705d967fe1f759c542842fa3709c3d43/hindsight-integrations/coding-agents/package.json)、[DSH 适配器](https://github.com/vectorize-io/hindsight/blob/0a7ed29d705d967fe1f759c542842fa3709c3d43/hindsight-integrations/coding-agents/src/dsh.ts)、[构建配置](https://github.com/vectorize-io/hindsight/blob/0a7ed29d705d967fe1f759c542842fa3709c3d43/hindsight-integrations/coding-agents/tsup.config.ts)。
- [客户端 reflect、recall 与 pages 返回值处理](https://github.com/vectorize-io/hindsight/blob/0a7ed29d705d967fe1f759c542842fa3709c3d43/hindsight-integrations/coding-agents/src/core/hindsight.ts#L841)、[正文检索与目录刷新顺序](https://github.com/vectorize-io/hindsight/blob/0a7ed29d705d967fe1f759c542842fa3709c3d43/hindsight-integrations/coding-agents/src/core/hook.ts#L199)。
- [RecallResponse 定义](https://github.com/vectorize-io/hindsight/blob/0a7ed29d705d967fe1f759c542842fa3709c3d43/hindsight-api-slim/hindsight_api/api/http.py#L1029)、[token 预算过滤（审阅 main）](https://github.com/vectorize-io/hindsight/blob/80bd005fc2be5c9604a1a0c9741ea93d5ac85156/hindsight-api-slim/hindsight_api/engine/memory_engine.py#L11270)：返回数量是最终响应内容，不是全库候选或总命中。
- [Reflect 证据按 include.facts 返回](https://github.com/vectorize-io/hindsight/blob/0a7ed29d705d967fe1f759c542842fa3709c3d43/hindsight-api-slim/hindsight_api/api/http.py#L5879)、[trace 按需构建（审阅 main）](https://github.com/vectorize-io/hindsight/blob/80bd005fc2be5c9604a1a0c9741ea93d5ac85156/hindsight-api-slim/hindsight_api/engine/memory_engine.py#L11564)：摘要无需引入额外证据参数或 trace 开销。
- [公开 pages 搜索及兼容别名](https://github.com/vectorize-io/hindsight/blob/0a7ed29d705d967fe1f759c542842fa3709c3d43/hindsight-api-slim/hindsight_api/api/http.py#L6999)、[bank 缺失的 404 行为（审阅 main）](https://github.com/vectorize-io/hindsight/blob/80bd005fc2be5c9604a1a0c9741ea93d5ac85156/hindsight-api-slim/hindsight_api/engine/memory_engine.py#L15317)。pages 计数是返回列表长度，score 不作相关性概率展示。

上述 API 源码证明已有接口足够实现摘要，无需修改 Hindsight 服务。它们不能单独证明当前部署服务与该提交完全一致。

## 3. 关键设计决定

### 3.1 当前状态与历史记录分开取值

运行时新增 Cordis 服务 `hindsightRuntime`，由正在执行的 DSH 适配器注册。管理器通过可选 `ctx.inject(['hindsightRuntime'])` 取得服务，卸载时清除引用。基础配置路由不依赖该服务，因此旧运行时仍能使用配置面板。

服务有两个方法：

```ts
interface HindsightRuntimeService {
  inspect(agent: DshAgent | undefined): RuntimeInspection;
  queryScope(): { sessionId: string; ownerTurn: number; recallId: string } | undefined;
}
```

`inspect()` 先取得当前执行模块的版本和能力；agent 为 undefined 时立即返回 `session_not_active`、该运行时描述和 `effective: null`，不执行 workspaceRoot，也不读取历史配置。只有存在 agent 时才同步读取工作区缓存，使用与实际召回相同的 `workspaceRoot(agent)` 定位，不能另外按 UI 当前目录重新解析配置。其返回状态为：

| 状态 | 已知事实 |
| --- | --- |
| `session_not_active` | 该会话没有活跃 agent；仍返回当前已加载运行时版本与能力，effective 为 null |
| `excluded_subagent` | 当前运行时不为这个子 agent 执行自动记忆 |
| `workspace_uninitialized` | 活跃 agent 存在，但该运行时尚未初始化其工作区 |
| `disabled` | 该工作区已有明确的禁用缓存 |
| `ready` | 该工作区已有实际运行实例，可以读取生效值 |

`ready` 的投影来自新增 `RuntimeCore.describeRuntime()`，只返回 bankId、客户端实际 apiUrl、autoInject、autoInjectEveryTurns、retainSessions，以及已有 cfg 中的 injectTimeoutMs 和 recallOptions 相关字段。不返回 token，不为显示额外读取配置或发请求。禁用缓存为 null 时仅说明未启用，不虚构无法从缓存得知的具体原因和 bank。

另返回 `hooksDisabled`，只观察上游已有 `HINDSIGHT_DISABLE_HOOKS` 条件的当前值；该条件会让自动召回和会话回写跳过执行，界面必须同时显示“配置开关”和“当前 hooks 已停用”，不能只凭 retainSessions=true 宣称正在回写。本任务不新增或推荐任何环境变量注入方式，也不修改该上游条件；新的可调参数仍只用根目录文件。

管理器新增 `GET /plugins/dsh-hindsight-manager/runtime?sessionId=...`。通过现有 `agents.get(sessionId)` 查询，不调用 create/resume。接口总是可用，并用明确状态表示 `runtime_unavailable`、`agent_service_unavailable` 或上述运行时返回状态。只要运行时服务存在，就调用 inspect，找不到活跃 agent 时传 undefined；因此历史会话尚未激活时仍能确认当前已加载运行时的版本和能力，但没有该会话的生效配置。没有服务只能证明当前没有可查询接口，不能证明官方插件一定未加载。

接口示意：

```json
{
  "protocolVersion": 1,
  "sessionId": "session-a",
  "status": "ready",
  "hooksDisabled": false,
  "runtime": {
    "upstreamVersion": "0.8.8",
    "patchSetVersion": "2",
    "capabilities": {
      "autoInjectEveryTurns": true,
      "runtimeInspection": true,
      "recallSummary": true,
      "injectionCorrelation": true
    }
  },
  "effective": {
    "workspaceRoot": "/project-a",
    "bankId": "project-a",
    "apiUrl": "http://memory.internal",
    "autoInject": "recall",
    "autoInjectEveryTurns": 1,
    "retainSessions": true,
    "injectTimeoutMs": 7000,
    "recallOptions": { "types": ["observation"], "budget": "low", "max_tokens": 2000 }
  }
}
```

执行代码自身声明构建能力和协议版本；磁盘上的 `dsh-enhancement.json` 仍只代表关联产物。首版不新增“重启后的精确预期配置”解析器，保存后的重启提示继续明确展示；只有运行实例提供的值才标成当前生效值。

### 3.2 当前状态 UI 入口

在 `conversation.session.header.utilities` 注册 Hindsight 按钮，使用 props.sessionId。打开后展示原生 dialog（`showModal()`），避免标题区域裁剪。面板展示当前状态、配置字段、实际增强版本和一个“重新读取”按钮；不新增设置项。

在面板打开、打开状态下 sessionId 变化、手动重新读取时请求一次。查询完成后显示本次读取时间；切换 sessionId 时清除上一会话结果并取消旧请求，避免旧响应覆盖新会话。页面刷新后重新打开即查询当前进程，不依赖上一轮事件。无活跃 agent 的历史会话明确标成“当前会话未激活”，历史活动行继续表示当时发生的事。

配置设置页保持全局配置编辑职责。只在会话入口展示当前生效状态，避免设置页没有确定 sessionId 时猜测当前工作区。

### 3.3 每次正文检索提供结构化结果

每次 pre-step 中存在新的真实用户文本时，生成一个 recallId；从宿主参数取得 ownerTurn。工具续步没有新用户文本，不创建新的摘要。一个 turn 中的用户追加消息可能产生多个 recallId，前端按 recallId 展开，仍保留一行 turn 级 Hindsight 活动。

用户文本在核心的既有 `stripInjectedMemory()` 清洗后变为空时，将已创建的本次摘要结束为 `skipped/no_user_text`；这与一开始就没有用户消息的工具续步分开处理，不改变原有清洗与跳过行为。

DSH 适配器为每次调用创建局部 collector，沿 onPrompt → buildHookOutput 传入可选阶段报告回调和正文 scope runner。每完成或中止一个阶段即把结果报告给 collector；适配器是唯一对外事件生产者。`buildHookOutput()` 正常返回本次 `retrieval` 结果，`RuntimeCore.onPrompt()` 返回它并补充 `bodyPresent`，不另建按 session 缓存统计的 Map。现有正文和页面组装返回值保持原意，既有 `getInjection()` 仍提供消息文本。

正文检索链退出时，collector 立即冻结本次检索结果、阶段列表和 totalDurationMs；后续页面目录刷新及消息组装仍按原顺序执行。取消可以抛出异常，不能只靠正常 return 取得已完成阶段：若在正文检索期间取消，适配器用本次 collector 形成 cancelled 记录；若正文已完成而后续准备阶段取消或抛错，保留检索结果，仅追加 preparation interruption。原本向外抛出的错误记录后原样抛出，原本返回 decision 的取消分支仍按原方式返回，不能为观测改变控制流。

因此“检索成功，页面目录刷新时取消”应展示“检索完成；准备阶段取消；正文未确认提交”，不能把已完成检索改报 cancelled、增加目录等待到检索耗时，或把尚未组装的正文标成不存在。运行时未启用、子 agent 排除、现有 hooks 禁用等在进入核心前已确定的分支，生成带实际 inspection 的 skipped 记录，effective 为 null 的状态不填造配置。

每个阶段表示一次 reflect、pages 或 recall 的逻辑调用，包含该调用内部已有重试、鉴权重放与兼容路径耗时。阶段数量不代表 HTTP 请求次数。只在已有分支处记录事实，不重新执行检索、不解析诊断日志、不调用 trace。

统计口径：

| 模式或情况 | 统计与文案 |
| --- | --- |
| recall 成功 | 客户端最终返回的非空记忆文本数量，称“可用记忆” |
| pages 成功 | 客户端实际返回页面条数，称“页面” |
| reflect 成功 | 返回非空合成文本及其字符数；不推断是否找到了相关事实 |
| 200 空结果 | `empty`，数量为 0，确认为该次客户端结果为空 |
| 404 被现有客户端转为空数组 | `not_found`，保留 httpStatus 404，原因未确认；不称为成功且零命中 |
| 明确 PagesUnavailableError | `unavailable`，表示客户端确认页面接口不可用或已有该缓存 |
| HTTP 失败 | `failed`，记录已有 HTTP 状态 |
| 无 HTTP 响应的失败 | `failed`，只记录 `network`、`timeout` 等实际错误类别 |
| 正文检索中 caller 取消 | `cancelled`，保留已经完成的阶段，不改取消传播 |
| 正文检索结束后准备阶段取消或失败 | 保留已确定的检索结果和耗时，另记 interruption；注入仍待宿主提交证明 |
| 未进入正文检索分支 | `skipped`，直接映射实际分支为 `mode_none`、`deferred_new_bank`、`cached_decision`、`hooks_disabled`、`workspace_disabled`、`excluded_subagent` 或 `no_user_text` |

为辨别 404，给现有客户端方法的 opts 增加可选 `onResponse({status, routeKind})`。`req()` 在循环内 fetchWithAuth 返回响应之后立即报告，覆盖其后可能抛出的 RateLimitedError；pagesReq 将回调带入已有两条路径；reflect 的直接 fetch 路径在取得响应时报告。回调可能触发多次，但每次逻辑阶段只保存自己的最后响应，禁止使用共享 `client.lastResponse`，避免并发串线。客户端已有 string/string[] 返回类型和兼容行为不变。

阶段最终因网络错误、超时或取消结束时，httpStatus 为 null；不能把之前一次 429/401 的响应状态冒充最终失败的 HTTP 状态。只有实际收到终止该阶段的 HTTP 响应时才标记其状态码，另用原有错误类型区分限流与网络失败。

耗时使用单调时钟，单位毫秒。totalDurationMs 覆盖正文检索链，包括已有等待、重试和降级；不包括模型生成、页面目录刷新、自动回写。没有开始检索时 totalDurationMs 为 null；不把 null 转成 0。injectTimeoutMs 不是整条链的严格总截止时间：已有 HTTP 超时、429 等待及 reflect 后降级会共同影响总耗时。字符数口径固定为 JavaScript 字符串 length，界面不称 token 数。

频率 N 的现有实现是在到期轮清除缓存；非到期轮若上次没有结果、还有原有跨轮重试预算，也可能实际检索。因此不能仅按轮号取模就标记“频率未到”。skipReason 必须来自真实执行分支；首版用 cached_decision 表示缓存决策，不声称更具体的理由。

### 3.4 结构化事件与 HTTP 观察去重

适配器是唯一的对外事件生产者，核心 hook 只更新本次 collector 并返回结果。适配器通过 `ctx.emit('hindsight/observation', {agent, record})` 报告 running 和最终结果；管理器将 record 保存为 `plugin:dsh-hindsight-manager/recall`。每次事件携带完整的本次配置、阶段快照和阶段状态，最终事件可以独立恢复该次详情。事件数据包含 `turn: null` 和 `ownerTurn`，沿用现有活动避免晚到记录移动宿主 timeline 游标的约定。

记录草案（字段示例值只用于解释结构，不是默认配置）：

```ts
type RecallRecord = {
  protocolVersion: 1;
  turn: null;
  ownerTurn: number;
  recallId: string;
  inspection: RuntimeInspection; // 包含 runtime/version、status、hooksDisabled、effective|null
  requestedMode: 'none' | 'recall' | 'pages' | 'reflect' | null;
  status: 'running' | 'completed' | 'empty' | 'failed' | 'cancelled' | 'skipped';
  interruption: { phase: 'preparation'; kind: 'cancelled' | 'failed' } | null;
  degraded: boolean;
  skipReason: 'mode_none' | 'deferred_new_bank' | 'cached_decision'
    | 'hooks_disabled' | 'workspace_disabled' | 'excluded_subagent' | 'no_user_text' | null;
  totalDurationMs: number | null;
  stages: Array<{
    mode: 'recall' | 'pages' | 'reflect';
    status: 'completed' | 'empty' | 'not_found' | 'unavailable' | 'failed' | 'cancelled';
    durationMs: number;
    httpStatus: number | null;
    errorKind: string | null;
    result: { unit: 'memories' | 'pages' | 'characters'; count: number } | null;
  }>;
  bodyPresent: boolean | null; // 尚未完成正文组装时为 null，包括准备阶段中断
};
```

`status: completed, degraded: true` 表示既有降级链最终取得可用结果；早期阶段失败仍在详情中显示。整个链没有结果时按实际阶段形成 empty/failed；404 或 unavailable 不能让摘要显示“检索成功 0 条”。不适用及尚未得出的值使用 null，不引入隐式默认。skipReason 与实际 if/return 分支及测试一一对应。最新 hook 仅在 `reflectAnswer && reflectRanThisTurn` 时输出记忆正文；缓存决策跳过检索时不会重新注入缓存正文，但仍可能有页面目录。摘要保持这个实际行为，不新增缓存正文重注入功能。

正文检索范围使用独立 AsyncLocalStorage。DSH 适配器创建 scope runner，经 onPrompt 传给 buildHookOutput，只包裹正文 autoInject 分支和既有 reflect 降级链；后续页面目录刷新在 scope 外。现有 `withCallerSignal` 包裹整个 hook，继续专用于取消，不改变其数据类型或含义。

管理器 undici request:create 观察器读取可选 `hindsightRuntime.queryScope()`：处在有明确 recallId 的正文 scope 时，该请求由结构化摘要负责，不再生成一条 HTTP 活动。目录查询、启动任务、自动回写和手动工具继续使用现有活动记录。不能按当前 turn、URL 或时间段笼统屏蔽请求。服务不存在时沿用现有 HTTP 活动展示，明确没有结构化结果可用。

### 3.5 注入确认及历史回放

注入消息 source 保留现有 kind/form，增加最小关联信息：

```json
{
  "kind": "plugin:hindsight",
  "form": "recall",
  "hindsight": { "protocolVersion": 1, "ownerTurn": 3, "recallId": "recall-a", "bodyPresent": true }
}
```

`bodyPresent` 由 RuntimeCore 在正文组装时得出，不能用整个 injection 字符串是否非空推断。消息 content 完全不变，统计信息只存在于 source 和插件事件。

前端活动解释器同时匹配结构化 recall 记录和带上述 source 的已提交 `user/message`，按 ownerTurn/recallId 归并。看到 source.bodyPresent=true 的已提交消息，才显示“记忆正文已进入上下文”；false 显示“仅提交目录/工具说明”。这不承诺模型已经使用正文或服务端已有新记忆。

运行时已准备正文但未见提交时显示“待确认提交”。即使 turn 结束，单凭缺消息也不宣称取消；若已有明确 cancelled 或 interruption 记录则显示对应阶段中断。适配器返回之后、宿主实际提交之前发生的取消，适配器可能无法观察，因此仍只显示“未看到提交记录”，不追造取消事件。局部历史窗口只有 source 时仍可证明正文提交，但显示“检索详情未加载”；只有摘要没有 source 时显示“未看到提交记录”，不得伪造零结果或已注入。加载更早历史后重新归并。源消息与摘要均用匹配 ID 去重，不依赖整个会话被一次性加载。

不为确认注入监听 `session/event` 后再次 append，也不向 source 塞入整份统计。保留既有事件展示与旧历史兼容：没有新协议的数据只能展示现有“已调用/未调用”等事实。

## 4. 分阶段任务与验收

实施顺序是 A → B → C → D → E。B 完成事件契约后，C 的后台接入与 D 的前端实现可以并行，但最终端到端验收必须使用同一份最新版本构建产物。

| 阶段 | 文件及任务 | 完成条件 |
| --- | --- | --- |
| A：最新基线与旧能力移植 | 再查 npm latest/gitHead 和仓库 main，采用最新发布对应源码与完整发布包；当前为 0.8.8；逐项移植既有四补丁行为到 `src/dsh.ts`、`src/core/runtime.ts`、`src/core/hook.ts`、`src/core/hindsight.ts`，保留上游新增行为；迁移已有运行时回归测试；固定协议和真实 skipReason | 最新运行时已有能力测试通过；无整段旧文件覆盖；最新发布与 main 差异有记录；若 latest 已变化则更新版本目录、构建和测试基线 |
| B：运行时生产数据 | 在最新源码增加 describeRuntime、inspect/queryScope、结构结果、可选响应回调、DSH事件、source关联信息；增加相应源码测试；形成 `runtime-patches/0.8.8/source.patch`；用上游 build 生成 DSH bundle 和对应 `delivery.patch` | 读状态零初始化零 HTTP；所有检索路径有准确结果；同 turn 追加消息拥有独立 recallId；目录请求不被正文去重范围吞掉；发布补丁可由源码构建重现 |
| C：管理器后端 | `index.js` 增加可选服务引用和 runtime GET；`activity.js` 保存结构化事件并依据 queryScope 去重；扩展 `tests/dsh-manager.test.mjs`、`tests/activity.test.mjs`、`tests/host.test.mjs` | 无服务/服务晚到/卸载/重载均有真实状态；旧配置面板可用；并发会话无串线；已有四个未提交文件改动保留 |
| D：管理器前端 | `client.js` 注册会话 utilities 按钮和 dialog、读取状态、扩展活动解释器和中英文文案；扩展 `tests/client.test.mjs`、活动回放测试 | 未发新消息即可查询；切换会话不串数据；摘要含阶段/耗时/结果/正文提交；旧历史及局部窗口不产生虚假成功 |
| E：组合与离线交付 | 扩展 `tests/runtime/settings.test.mjs` 或同目录新增观测组合测试并接入 `scripts/test-runtime.mjs`；更新 `manager.config.json`、补丁声明、`runtime-patches/README.md`、`README.md` 和必要 package files | 运行时、宿主、管理器组合测试通过；最新官方完整包+delivery.patch 可以离线重现；产品说明与实际状态语义一致 |

阶段 A 的迁移清单固定如下，逐项以最新源码实现，不把旧 dist 整段复制回去：

| 既有能力 | 最新源码落点 | 保留与验收 |
| --- | --- | --- |
| 实例生命周期及会话工具 | `src/dsh.ts` | 闭包内缓存、agent/created、卸载 flush、保留 pre-step decision 字段；保留 ownEvents 的 fork 边界，验证重载与多工作区 |
| 请求取消 | `src/core/hindsight.ts`、`hook.ts`、`runtime.ts`、`page-tools.ts` 及原工具辅助 | 沿用 caller signal 的独立作用域；取消传入 fetch、响应体读取和429等待；不能把取消变空结果或触发降级 |
| 主动召回及配置 | `src/core/config.ts`、`hook.ts`、`runtime.ts`、`src/dsh.ts` | 根目录默认值、到期清缓存、去除跨轮相同文本抑制；保留 latest 的 preambleOnFirstTurn=true 与 stripInjectedMemory |
| 启动目录与工具隔离 | `src/dsh.ts` | 无启动目录初始化时取工具 schema；执行时按 calling agent 解析；验证启动目录禁用仍能供已启用工作区使用，子 agent 排除 |
| 回写提交与404 | `src/core/runtime.ts`、`hindsight.ts`、`retain-cursor.ts` | 只有成功提交才推进 retainedTurns；失败可重试；retain404及 pending appends 失败继续抛出；验证并发 stop、旧快照和部分提交 |
| 参数、声明、测试与构建 | 根参数/声明、package.json、`src/dsh.test.ts`、`src/core/*.test.ts`、tsup.config.ts | 源码测试替代文本切片测试的主要职责，保留实际 dist 宿主及管理器组合验收；README 派生 skill 按上游脚本生成 |

`RuntimeCore` 的私有字段读取以只读方法落实。源码 patch 是唯一维护源；发布补丁通过上游构建生成，禁止手工修 dist 后让源码落后。构建可产生多个适配器，但交付仅包含 DSH bundle、其专用测试/根目录参数/增强声明及必要 package 条目，不替换其他 harness bundle。继续使用上游 build 配置；若 DSH bundle 引入宿主提供的 `@deepseek-ai/dsh-session` 等模块，要在 tsup externals 中保留宿主解析，不能把第二份宿主会话实现打入 bundle。

阶段 B 同步扩展 `src/dsh.ts` 的本地结构类型：DshContext 增加 provide/emit/effect 及实际使用的生命周期签名；PreStepPayload 增加宿主传入的 turn/step；DshUserMessage.source 增加关联元数据。继续使用局部结构类型，不为此引入整套 DSH 包依赖。服务在该文件 apply 创建的同一 runtime 实例上注册；实际加载链是 cordis.patch.yml → 包导出 `/dsh` → dist/dsh.js，不能改到供 OpenCode 使用的包根 index.js、`.` 或 `/server` 导出。

## 5. 必须覆盖的测试

测试聚焦行为及接口边界，避免测试仅重复对象拼装实现。

1. **实际配置与缓存：** 两个工作区分别命中不同 bank 和服务；保存配置后已初始化工作区报告旧值，新工作区按现有逻辑加载新值；同目录新会话仍报告真实缓存值。inspect 前后缓存大小、客户端构造次数、HTTP 请求次数不变。
2. **运行状态生命周期：** provider 不存在、agent 不活跃、工作区未初始化、禁用、子 agent 排除、ready；冷历史会话的 GET 返回当前 provider 版本/能力、session_not_active 和 effective:null，断言不调用 workspaceRoot、create/resume 或读取历史配置；既有 hooks 禁用条件生效时配置开关仍显示原值、执行状态明确停用；provider 晚加载/卸载后 GET 结果变化。
3. **召回语义：** recall 过滤空白文本后的计数；pages 正常、兼容路径、页面不可用；reflect 非空/空文本；200 空结果与 404 转空数组区分；401 重放、429 重试、网络失败和超时的阶段耗时包含已有处理。
4. **降级与取消：** reflect 失败后 pages/recall 成功时摘要标记降级完成；阶段全空与失败区别；检索中取消；检索完成后页面目录刷新取消/抛错时保留检索成功与原耗时、记录 preparation interruption、bodyPresent 未知、无注入确认；适配器返回后宿主提交前取消仍不误报已注入；首轮仅目录/说明；autoInject none、到期清缓存、非到期但仍实际检索、缓存与延后分支。测试均不新增真实服务请求。
5. **宿主真正提交：** 使用真实 DSH AgentLoop/SessionStore 跑 pre-step 到 user/message，检查 source 持久化和恢复；同一文本再次注入、工具续步不重复；新增插件记录仍不进入模型请求，模型消息 content 与改动前一致。
6. **归属与去重：** 两个并发会话、同 turn 多次输入、跨 turn 的晚到回写；正文 scope 内多次 HTTP 仅归为一个逻辑摘要；scope 外页面目录请求及手动工具保留原活动；工具内部 HTTP 仍不重复。
7. **前端与历史窗口：** 切换 sessionId 的旧请求不能覆盖新值；刷新后即时查询当前运行时；完整回放、仅最终摘要、仅 source、只有旧协议记录、加载更早历史；未加载详情显示未知，不出现虚构的 0 条/已注入。
8. **请求与正文等价：** 先保存阶段 A 的“最新版本+已迁移既有 DSH 能力”基线，再与阶段 B 新增观测后的同场景比较 Hindsight 请求序列、URL、请求体、取消传播、注入 content 和回写 transcript；统计新记录及 source 元数据之外均一致。不能与旧 0.8.7 或裸 0.8.8 比较来要求正文完全一致，因为上游 preamble 与已迁移能力本来就不同。这是“增加观测但不改变记忆行为”的主要验收。

本地验收命令：

```bash
npm run check
npm test
npm --prefix /absolute/path/to/prepared/hindsight-coding-agents run test:dsh
npm run test:runtime -- /absolute/path/to/prepared/hindsight-coding-agents
```

源码维护副本还需进入 `hindsight-integrations/coding-agents/`，按该包自己的 package-lock.json 准备开发依赖，再执行 `npm test`、`./node_modules/.bin/tsc --noEmit` 和 `npm run build`。该包不在 monorepo 根 workspaces 内，不能把根目录安装或构建当作完成；tsup 的声明入口只覆盖 src/index.ts，build 通过也不能代替 src/dsh.ts 的完整类型检查。源码测试同时验证共享核心的可选观测参数没有改变其他适配器的已有行为。依赖在开发端预先准备；离线发布包保留由旧补丁迁移来的 `test:dsh` 脚本与测试文件，因此部署验收不要求安装 TypeScript 开发依赖。

发布前增加一次真实 DSH Web 手动验收：空白会话打开状态、旧会话尚未发消息、切换工作区、完成一次有结果及一次空结果召回、取消一次请求、刷新恢复。对部署服务的真实结果验证使用已有内网测试 bank，查询即可，不为本计划写入测试记忆。没有可用内网服务时如实记录未验证，不以模拟测试冒充。

## 6. 参数、版本与离线交付

新增功能不需要轮询周期、额外超时或新检索预算。已有根目录 `manager.config.json` 继续管理包路径、版本兼容及已有请求参数，官方包根目录 `dsh-memory.config.json` 管理记忆行为；不新增环境变量入口。实施若发现确实需要可调值，应先在对应根目录文件定义并明确用途，不能散落数字。

服务名、事件名、协议版本、状态枚举、source 字段名属于通信契约，作为命名常量保留在代码中；它们不是部署可调参数。已加载版本及能力由当前执行模块提供，安装声明用于安装信息，不能读声明来伪装运行证明。

新交付放在 `runtime-patches/0.8.8/`，目录名随实施时 latest 更新。`source.patch` 对应 npm gitHead 源码；`delivery.patch` 对应同版本完整发布包。新增强声明使用当前官方版本、`patchSetVersion: "2"`；capabilities 保留现有对象形状及 `autoInjectEveryTurns: true`，追加 runtimeInspection、recallSummary、injectionCorrelation 三个布尔字段，运行时也使用同样的能力对象。`manager.config.json` 的支持基线和 `tests/runtime/settings.test.mjs` 对完整声明的断言同时更新。旧四份 0.8.7 补丁作为旧版本资料保留，README 的当前安装入口只指向最新目录，禁止混用。尚未升级的旧运行时只报告其接口实际可提供的事实，不显示新能力已启用。

离线准备完整官方最新包（本次 0.8.8）、Node.js、DSH 及所需测试文件，在干净发布目录只应用配套 delivery.patch。已有增强 0.8.7 的安装需要换为准备好的新目录，不能在旧目录直接追加新补丁。运行上述验证，再将 `officialPackagePath` 指向实际加载目录并重启 DSH。管理器不下载、不自动更新、不自动重打补丁。本次计划不包含安装脚本、发布、PR 或修改用户的运行目录。

文档应明确：状态查询只访问同一 DSH 本地路由；摘要复用已有内网请求；无需外网服务、额外端点或新的凭据配置。

开发端跟进上游的最小流程：每次开始实现、更新增强或交付前查询 npm latest 与 gitHead，同时查看 main 中 coding-agents/相关 API 的未发布差异；在新 release 源码上移植 source.patch，删除上游已吸收的改动，保留尚未吸收的既有行为；用该版本上游 build 重建，生成新的 delivery.patch；运行本计划的运行时与组合测试后更新版本目录和根配置。最新发布变化后必须重新跑这一流程，不能只改版本号。利用现有 CI 执行这些本地测试即可，不增加部署端联网服务或自动安装器。

## 7. 收益、代价与完成定义

| 项目 | 可验收的收益 | 代价和限制 |
| --- | --- | --- |
| 当前实际状态 | 配置保存、工作区覆盖、bank 解析及增强加载问题可以直接定位；无需发送一条测试消息 | 增加一个只读服务和本地路由；未活跃会话没有当前实例可供查询 |
| 本轮召回摘要 | 将“没记住”拆分为没查、查失败、空结果、降级、未提交、已进入上下文 | 需要修改核心返回数据及客户端观测点；不直接提高检索质量 |
| 准确注入确认 | 取消及仅目录注入不会误报为记忆正文已注入 | 只证明正文进入请求上下文，不证明模型采纳；局部历史可能缺详情 |
| 联合交付 | 同一 recallId 下可看见当时实际配置和结果，减少手工翻日志排查 | 升级官方版本时需重新核对补丁观测点及宿主接口 |

工程规模预计约 6–10 个专注开发日：最新版本移植及源码/发布产物对齐 1–2 日、协议与运行时 2–3 日、后端及界面 1–2 日、组合验收和离线文档 2–3 日。范围以测试结果为准；这不是对部署环境已有行为的保证。

本地验收通过。管理器 76 项测试、运行时源码 1449 项测试、离线运行时 5 项测试、DSH 组合验收 17 项测试均通过。另对同一 0.8.8 基线的 10 个场景比较了新增观测前后的请求、注入正文、取消和会话回写。

在干净的上游源码上应用 `source.patch` 后完成类型检查与构建。构建出的 `dist/dsh.js` 和干净发布包应用 `delivery.patch` 后的文件逐字节一致。临时 DSH Web profile 已离线安装两份产物，正常认证后页面、设置接口及冷会话运行状态接口均返回成功。浏览器手动交互和实际内网 Hindsight 服务仍待部署环境验收。
