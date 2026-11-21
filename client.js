window.__ModuleLoader__.load({
  id: 'dsh-hindsight-manager',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState, useCallback, useRef } = React;

    const NS = 'hindsight-manager';
    const CONFIGURED_BUDGET_OPTION = 'hm-configured-budget';

    const ROUTES = {
      state: '/plugins/dsh-hindsight-manager/state',
      test: '/plugins/dsh-hindsight-manager/test',
      banks: '/plugins/dsh-hindsight-manager/banks',
      save: '/plugins/dsh-hindsight-manager/save',
      runtime: '/plugins/dsh-hindsight-manager/runtime',
    };

    // -- i18n -----------------------------------------------------------------

    const zh = {
      title: 'Hindsight 记忆',
      intro:
        '管理官方 Hindsight 插件的服务地址与工作区记忆库（bank）。请先从 DSH 插件市场安装并启用 @vectorize-io/hindsight-coding-agents。',
      connection: '连接',
      apiUrl: '服务地址',
      apiUrlHint: '填 REST 根，例如 http://host:8888。不要带 /mcp 后缀 —— 那会让所有请求静默返回空对象。',
      test: '测试连接',
      testing: '测试中…',
      banks: '工作区映射',
      banksHint: '路径前缀匹配，最长优先。官方插件根据这些配置选择记忆库。',
      dir: '工作区目录',
      bank: '记忆库',
      status: '状态',
      add: '添加映射',
      remove: '移除',
      save: '保存',
      saved: '已保存，请重启 DSH 使配置生效',
      saving: '保存中…',
      reload: '重新读取',
      exists: '目录存在',
      missing: '目录不存在',
      unchecked: '保存后检查目录',
      notMapped: '未映射',
      options: '选项',
      optInOnly: '仅限已授权工作区',
      optInOnlyHint: '开启后，仅映射目录和配置文件 optInPaths 中的目录启用记忆。关闭则由官方插件为其他工作区解析记忆库。',
      retainSessions: '会话回写',
      restNote: '保存后请重启 DSH，让官方插件读取新配置。测试连接与刷新库列表使用已保存的配置。',
      loading: '读取中…',
      errorLoading: '读取配置失败',
      enterPath: '输入工作区绝对路径',
      bankPlaceholder: 'bank 名',
      unknownBanks: '无法枚举服务器上的库',
      refreshBanks: '刷新库列表',
      scope: '这里编辑同一官方配置文件中的 DSH 默认设置。工作区的 paths、banks 覆盖仍由官方插件解析。',
      inherit: '继承',
      explicit: 'DSH 显式设置',
      restore: '恢复继承',
      pendingInherit: '待保存：恢复继承',
      pendingEdit: '待保存：DSH 显式设置',
      restoreEditHint: '恢复继承待保存。继续编辑会撤销本组恢复，按原配置只保存新修改。',
      source: '已保存配置来源',
      source_default: '官方默认',
      source_policy: '关联增强默认',
      source_global: '顶层配置',
      source_dsh: 'DSH 配置',
      configuredValue: '文件原值',
      effectiveValue: '解析展示值',
      preserveValue: '修改其他设置不会改写此值。',
      serverMode: '连接模式',
      apiPort: '端口',
      tokenConfigured: 'Token 已配置',
      tokenMissing: 'Token 未配置',
      optInPaths: '额外授权目录',
      optInPathsHint: 'JSON 字符串数组；这些目录与工作区映射共同决定授权范围。',
      common: '自动召回与会话回写',
      autoInject: '自动召回方式',
      mode_none: '关闭',
      mode_recall: '检索事实',
      mode_pages: '查找页面',
      mode_reflect: '推理合成',
      autoInjectHint: '关闭仅停止自动检索和注入记忆正文。记忆工具、页面目录与工具说明、会话回写独立运行。',
      autoInjectEveryTurns: '召回频率（用户回合）',
      frequencyHint: '0：首次召回（空结果或失败仍可能重试）；1：每个用户回合；N：第 1、1+N、1+2N 回合。工具续轮不重复触发。',
      frequencyCostHint: '按当前消息同步检索。频率越高，请求与重复上下文可能越多；不会加快记忆的异步提取。',
      retainSessionsHint: '关闭后不自动保存会话；仍可召回已有记忆，也不禁止手动工具写入。',
      advanced: '高级召回参数',
      recallOptions: '召回选项',
      recallFallbackHint: '这些选项用于 recall，也用于 reflect 失败后经 pages 再降级到 recall 的路径。切换方式会保留参数。',
      budget: '检索预算',
      budgetHint: '控制 recall 检索力度，不是注入文本长度。',
      maxTokens: '返回 token 预算',
      maxTokensHint: '限制 recall 响应；不包含页面或工具说明及会话历史，不是整轮上下文上限。',
      types: '记忆类型',
      allTypes: '所有类型（null）',
      typesHint: 'JSON 字符串数组；null 表示所有类型。保留空数组和自定义类型。常见类型：',
      typesMeaning: 'observation 为归纳记忆，world、experience 为原始事实类型。',
      injectTimeoutMs: '自动检索超时（毫秒）',
      timeoutHint: '用于 recall/pages 及 reflect 降级检索的共享等待预算；不限制 reflect 主体或整轮响应。',
      enhancementDeclared: '关联安装产物声明支持逐轮召回',
      enhancementUnlinked: '未关联逐轮召回增强',
      enhancementUndeclared: '关联产物未声明逐轮召回增强',
      enhancementError: '增强关联问题',
      enhancementInstalledOnly: '声明仅表示安装产物，不能证明当前 DSH 进程已加载。保存后仍需重启。',
      banksPage: '本页已显示 / 服务器总数',
      invalidNumber: '请输入非负整数',
      invalidArray: '请输入 JSON 字符串数组',
      activityRunning: '正在调用',
      activityCalled: '已调用',
      activityFailed: '调用异常',
      activityUnused: '本轮未调用',
      running: '进行中',
      completed: '完成',
      submitted: '已提交',
      failed: '失败',
      searchPages: '搜索记忆页面',
      listPages: '浏览记忆页面',
      readPage: '读取记忆页面',
      reflectMemory: '综合记忆',
      captureInitiative: '记录计划',
      ingestDocument: '保存资料',
      syncStatus: '检查同步状态',
      diagnose: '诊断记忆服务',
      autoRecall: '自动读取记忆',
      autoPages: '自动读取记忆页面',
      writeMemory: '写入记忆',
      writeBack: '回写会话',
      syncMemory: '同步项目记忆',
      surveyMemory: '提交项目研究',
      memoryService: '访问记忆服务',
      runtimeTitle: 'Hindsight 当前会话状态',
      runtimeError: '读取运行状态失败',
      runtimeReadAt: '读取时间',
      runtimeLiveNote: '这里显示当前运行实例。保存设置后请重启 DSH；历史活动中的配置表示当时使用的值。',
      runtime_runtime_unavailable: '当前运行时未提供状态接口',
      runtime_agent_service_unavailable: '当前无法查询活跃会话',
      runtime_session_not_active: '当前会话未激活',
      runtime_excluded_subagent: '当前子会话不执行自动记忆',
      runtime_workspace_uninitialized: '当前工作区尚未初始化',
      runtime_disabled: '当前工作区未启用记忆',
      runtime_ready: '当前工作区已初始化',
      runtimeVersion: '已加载上游版本',
      patchVersion: '增强版本',
      capabilities: '已加载能力',
      capability_autoInjectEveryTurns: '按用户回合召回',
      capability_runtimeInspection: '运行状态查询',
      capability_recallSummary: '召回摘要',
      capability_injectionCorrelation: '正文提交关联',
      hooks: '自动召回与回写 hooks',
      hooksDisabled: '已停用；配置开关仍显示实例原值',
      hooksEnabled: '已启用',
      enabled: '开启',
      disabled: '关闭',
      unknown: '未知',
      unavailable: '不可用',
      close: '关闭',
      frequency_initial: '首次召回（空结果或失败可能重试）',
      frequency_every: '每个用户回合',
      frequency_interval: '用户回合间隔',
      recallDetails: '本轮召回',
      recallConfiguration: '本次实际配置',
      recall_running: '正在召回',
      recall_completed: '召回完成',
      recall_empty: '召回结果为空',
      recall_failed: '召回失败',
      recall_cancelled: '召回已取消',
      recall_skipped: '未执行检索',
      recall_degraded: '召回已降级完成',
      recall_submitted: '上下文已提交',
      stage_completed: '完成',
      stage_empty: '空结果',
      stage_not_found: '未找到资源（404，原因未确认）',
      stage_unavailable: '接口不可用',
      stage_failed: '失败',
      stage_cancelled: '已取消',
      result_memories: '条可用记忆',
      result_pages: '个页面',
      result_characters: '字符合成文本',
      duration: '正文检索耗时',
      durationUnknown: '正文检索耗时未知',
      retrievalNotLoaded: '检索详情未加载',
      body: '记忆正文',
      bodyCommitted: '已进入上下文',
      directoryCommitted: '仅提交目录／工具说明',
      bodyPending: '已准备，待确认提交',
      noCommit: '未看到提交记录',
      bodyAbsent: '未构造记忆正文',
      bodyUnknown: '正文组装结果未知',
      preparation_cancelled: '准备阶段已取消',
      preparation_failed: '准备阶段失败',
      skip_mode_none: '自动召回已关闭',
      skip_deferred_new_bank: '新记忆库，检索已延后',
      skip_cached_decision: '沿用已有召回决策',
      skip_hooks_disabled: '自动召回与回写 hooks 已停用',
      skip_workspace_disabled: '当前工作区未启用记忆',
      skip_excluded_subagent: '当前子会话不执行自动记忆',
      skip_no_user_text: '没有可检索的用户文本',
    };

    const en = {
      title: 'Hindsight memory',
      intro:
        'Manage the official Hindsight plugin’s server and workspace banks. Install and enable @vectorize-io/hindsight-coding-agents from the DSH plugin marketplace first.',
      connection: 'Connection',
      apiUrl: 'Server URL',
      apiUrlHint: 'REST root such as http://host:8888. Do not append /mcp — that makes every request silently return an empty object.',
      test: 'Test connection',
      testing: 'Testing…',
      banks: 'Workspace mappings',
      banksHint: 'Path prefixes, longest wins. The official plugin uses these settings to select memory banks.',
      dir: 'Workspace directory',
      bank: 'Bank',
      status: 'Status',
      add: 'Add mapping',
      remove: 'Remove',
      save: 'Save',
      saved: 'Saved. Restart DSH to apply the settings.',
      saving: 'Saving…',
      reload: 'Reload',
      exists: 'directory exists',
      missing: 'directory missing',
      unchecked: 'save to check directory',
      notMapped: 'unmapped',
      options: 'Options',
      optInOnly: 'Approved workspaces only',
      optInOnlyHint: 'On: enable memory for mappings and optInPaths in the config file. Off: the official plugin resolves banks for other workspaces too.',
      retainSessions: 'Session write-back',
      restNote: 'Restart DSH after saving so the official plugin reads the settings. Connection testing and the bank list use saved settings.',
      loading: 'Loading…',
      errorLoading: 'Failed to read configuration',
      enterPath: 'Absolute workspace path',
      bankPlaceholder: 'bank name',
      unknownBanks: 'Could not enumerate banks on the server',
      refreshBanks: 'Refresh banks',
      scope: 'Edit DSH defaults in the shared official configuration file. The official plugin still resolves workspace paths and banks overrides.',
      inherit: 'Inherited',
      explicit: 'DSH override',
      restore: 'Restore inheritance',
      pendingInherit: 'Pending: restore inheritance',
      pendingEdit: 'Pending: DSH override',
      restoreEditHint: 'Restoring inheritance is pending. Editing cancels this group restoration and saves only the new edits against the original configuration.',
      source: 'Saved configuration source',
      source_default: 'Official default',
      source_policy: 'Linked enhancement default',
      source_global: 'Global configuration',
      source_dsh: 'DSH configuration',
      configuredValue: 'Configured value',
      effectiveValue: 'Resolved display value',
      preserveValue: 'Editing other settings preserves this value.',
      serverMode: 'Connection mode',
      apiPort: 'Port',
      tokenConfigured: 'Token configured',
      tokenMissing: 'No token configured',
      optInPaths: 'Additional approved directories',
      optInPathsHint: 'JSON string array. These directories and workspace mappings determine the approved scope.',
      common: 'Automatic recall and session write-back',
      autoInject: 'Automatic recall method',
      mode_none: 'Off',
      mode_recall: 'Recall facts',
      mode_pages: 'Search pages',
      mode_reflect: 'Reflect',
      autoInjectHint: 'Off stops automatic retrieval and injection of memory content. Tools, page directories, tool guidance and session write-back remain independent.',
      autoInjectEveryTurns: 'Recall frequency (user turns)',
      frequencyHint: '0: initial recall (empty results or failures may retry); 1: every user turn; N: turns 1, 1+N, 1+2N. Tool continuations do not trigger another recall.',
      frequencyCostHint: 'Retrieves synchronously for the current message. Higher frequency can add requests and repeated context; it does not speed up asynchronous memory extraction.',
      retainSessionsHint: 'Off stops automatic session retention. Existing memories can still be recalled and tools can still write memories.',
      advanced: 'Advanced recall parameters',
      recallOptions: 'Recall options',
      recallFallbackHint: 'Applies to recall, including reflect failures that fall back through pages to recall. Changing methods preserves these options.',
      budget: 'Search budget',
      budgetHint: 'Controls recall search effort, not the length of injected text.',
      maxTokens: 'Response token budget',
      maxTokensHint: 'Limits the recall response, excluding page/tool guidance and conversation history. It is not the whole-turn context limit.',
      types: 'Memory types',
      allTypes: 'All types (null)',
      typesHint: 'JSON string array; null means all types. Empty arrays and custom types are preserved. Common types:',
      typesMeaning: 'observation means consolidated memories; world and experience are raw fact types.',
      injectTimeoutMs: 'Automatic retrieval timeout (ms)',
      timeoutHint: 'Shared wait budget for recall/pages and reflect fallback retrieval. Does not limit reflect itself or the entire turn.',
      enhancementDeclared: 'Linked installation declares per-turn recall support',
      enhancementUnlinked: 'Per-turn recall enhancement is not linked',
      enhancementUndeclared: 'Linked installation does not declare per-turn recall support',
      enhancementError: 'Enhancement link problem',
      enhancementInstalledOnly: 'The declaration describes installed files, not the running DSH process. Restart after saving.',
      banksPage: 'Shown on this page / server total',
      invalidNumber: 'Enter a nonnegative integer',
      invalidArray: 'Enter a JSON array of strings',
      activityRunning: 'Calling',
      activityCalled: 'Called',
      activityFailed: 'Call error',
      activityUnused: 'Not called this turn',
      running: 'In progress',
      completed: 'Completed',
      submitted: 'Submitted',
      failed: 'Failed',
      searchPages: 'Search memory pages',
      listPages: 'List memory pages',
      readPage: 'Read memory page',
      reflectMemory: 'Reflect on memory',
      captureInitiative: 'Record initiative',
      ingestDocument: 'Save document',
      syncStatus: 'Check sync status',
      diagnose: 'Diagnose memory service',
      autoRecall: 'Automatically recall memory',
      autoPages: 'Automatically read memory pages',
      writeMemory: 'Write memory',
      writeBack: 'Write back conversation',
      syncMemory: 'Sync project memory',
      surveyMemory: 'Submit project survey',
      memoryService: 'Access memory service',
      runtimeTitle: 'Hindsight current session state',
      runtimeError: 'Failed to read runtime state',
      runtimeReadAt: 'Read at',
      runtimeLiveNote: 'Shows the current running instance. Restart DSH after saving settings; configurations in historical activity describe the values used then.',
      runtime_runtime_unavailable: 'The current runtime does not provide a state interface',
      runtime_agent_service_unavailable: 'Active sessions cannot currently be queried',
      runtime_session_not_active: 'This session is not active',
      runtime_excluded_subagent: 'Automatic memory is excluded for this subagent',
      runtime_workspace_uninitialized: 'This workspace has not been initialized',
      runtime_disabled: 'Memory is disabled for this workspace',
      runtime_ready: 'This workspace is initialized',
      runtimeVersion: 'Loaded upstream version',
      patchVersion: 'Enhancement version',
      capabilities: 'Loaded capabilities',
      capability_autoInjectEveryTurns: 'Recall by user turn',
      capability_runtimeInspection: 'Runtime inspection',
      capability_recallSummary: 'Recall summary',
      capability_injectionCorrelation: 'Context submission correlation',
      hooks: 'Automatic recall and write-back hooks',
      hooksDisabled: 'Disabled; configuration switches still show the instance values',
      hooksEnabled: 'Enabled',
      enabled: 'On',
      disabled: 'Off',
      unknown: 'Unknown',
      unavailable: 'Unavailable',
      close: 'Close',
      frequency_initial: 'Initial recall (empty results or failures may retry)',
      frequency_every: 'Every user turn',
      frequency_interval: 'User turn interval',
      recallDetails: 'Recall in this turn',
      recallConfiguration: 'Configuration used for this recall',
      recall_running: 'Recalling',
      recall_completed: 'Recall completed',
      recall_empty: 'Recall returned no results',
      recall_failed: 'Recall failed',
      recall_cancelled: 'Recall cancelled',
      recall_skipped: 'Retrieval skipped',
      recall_degraded: 'Recall completed after fallback',
      recall_submitted: 'Context submitted',
      stage_completed: 'Completed',
      stage_empty: 'Empty result',
      stage_not_found: 'Resource not found (404, cause unconfirmed)',
      stage_unavailable: 'Endpoint unavailable',
      stage_failed: 'Failed',
      stage_cancelled: 'Cancelled',
      result_memories: 'usable memories',
      result_pages: 'pages',
      result_characters: 'characters of synthesized text',
      duration: 'Content retrieval time',
      durationUnknown: 'Content retrieval time unknown',
      retrievalNotLoaded: 'Retrieval details not loaded',
      body: 'Memory content',
      bodyCommitted: 'Submitted to context',
      directoryCommitted: 'Only directory / tool guidance submitted',
      bodyPending: 'Prepared, awaiting submission confirmation',
      noCommit: 'No submission record observed',
      bodyAbsent: 'No memory content prepared',
      bodyUnknown: 'Content preparation result unknown',
      preparation_cancelled: 'Preparation cancelled',
      preparation_failed: 'Preparation failed',
      skip_mode_none: 'Automatic recall is off',
      skip_deferred_new_bank: 'Retrieval deferred for a new bank',
      skip_cached_decision: 'Using the existing recall decision',
      skip_hooks_disabled: 'Automatic recall and write-back hooks are disabled',
      skip_workspace_disabled: 'Memory is disabled for this workspace',
      skip_excluded_subagent: 'Automatic memory is excluded for this subagent',
      skip_no_user_text: 'No user text to retrieve against',
    };

    // -- styles ---------------------------------------------------------------

    const STYLE = `
.hm-root { display:flex; flex-direction:column; gap:18px; }
.hm-card { border:1px solid var(--dsh-border, #e3e3e3); border-radius:10px; padding:14px 16px; }
.hm-h { font-weight:600; margin:0 0 4px; font-size:14px; }
.hm-sub { color:var(--dsh-text-secondary, #6b6b6b); font-size:12px; line-height:1.5; margin:0 0 10px; }
.hm-row { display:flex; gap:8px; align-items:center; }
.hm-input { flex:1; min-width:0; padding:6px 9px; border:1px solid var(--dsh-border, #d0d0d0); border-radius:6px; background:var(--dsh-bg, #fff); color:inherit; font:inherit; font-size:13px; }
.hm-input:focus { outline:2px solid var(--dsh-accent, #4a7dff); outline-offset:-1px; }
.hm-btn { padding:6px 12px; border-radius:6px; border:1px solid var(--dsh-border, #d0d0d0); background:var(--dsh-bg-elevated, #f7f7f7); color:inherit; font:inherit; font-size:13px; cursor:pointer; white-space:nowrap; }
.hm-btn:hover:not(:disabled) { background:var(--dsh-bg-hover, #eee); }
.hm-btn:disabled { opacity:.5; cursor:default; }
.hm-btn-primary { background:var(--dsh-accent, #4a7dff); border-color:var(--dsh-accent, #4a7dff); color:#fff; }
.hm-btn-primary:hover:not(:disabled) { filter:brightness(1.07); }
.hm-btn-danger { color:#c0392b; }
.hm-list { display:flex; flex-direction:column; gap:8px; }
.hm-item { display:grid; grid-template-columns:1fr 180px auto auto; gap:8px; align-items:center; }
.hm-mono { font-family:var(--dsh-font-mono, ui-monospace, monospace); font-size:12px; }
.hm-badge { font-size:11px; padding:2px 7px; border-radius:999px; white-space:nowrap; }
.hm-ok { background:rgba(39,174,96,.14); color:#1e8449; }
.hm-bad { background:rgba(192,57,43,.14); color:#a93226; }
.hm-muted { background:rgba(127,127,127,.14); color:inherit; opacity:.8; }
.hm-note { font-size:12px; line-height:1.55; padding:9px 11px; border-radius:7px; }
.hm-note-ok { background:rgba(39,174,96,.12); }
.hm-note-bad { background:rgba(192,57,43,.12); }
.hm-check { display:flex; gap:7px; align-items:flex-start; font-size:13px; }
.hm-check input { margin-top:2px; }
.hm-empty { color:var(--dsh-text-secondary, #6b6b6b); font-size:12px; padding:6px 0; }
.hm-field { display:flex; flex-direction:column; gap:6px; margin-top:14px; }
.hm-origin { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12px; margin:6px 0; }
.hm-summary { cursor:pointer; font-weight:600; font-size:14px; }
.hm-input:disabled { opacity:.6; }
.hm-activity { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.6; padding:4px 0; }
.hm-activity summary { cursor:pointer; width:fit-content; }
.hm-activity[data-status="unused"] { color:var(--dsw-alias-label-tertiary); }
.hm-activity[data-status="failed"] summary { color:var(--dsw-alias-state-error-primary); }
.hm-activity ul { list-style:none; margin:6px 0 0; padding:0 0 0 20px; }
.hm-activity li { display:flex; flex-wrap:wrap; gap:6px; }
.hm-runtime-dialog { width:min(620px, calc(100vw - 40px)); max-height:calc(100vh - 48px); box-sizing:border-box; overflow:auto; padding:20px; border:1px solid var(--dsh-border, #e3e3e3); border-radius:10px; background:var(--dsh-bg, #fff); color:var(--dsw-alias-label-primary, #242424); }
.hm-runtime-dialog::backdrop { background:rgba(0,0,0,.35); }
.hm-runtime-title { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:14px; }
.hm-values { display:grid; grid-template-columns:minmax(110px, auto) minmax(0, 1fr); gap:5px 14px; font-size:12px; line-height:1.6; }
.hm-values dt { color:var(--dsh-text-secondary, #6b6b6b); }
.hm-values dd { margin:0; overflow-wrap:anywhere; white-space:pre-wrap; }
.hm-recall { margin:10px 0 8px 20px; border-left:2px solid var(--dsh-border, #e3e3e3); padding-left:12px; }
.hm-recall p { margin:4px 0; }
.hm-recall ol { margin:6px 0; padding-left:20px; }
.hm-recall li { display:list-item; }
@media (max-width:720px){ .hm-item { grid-template-columns:1fr; } }
`;

    // Each activity record carries its originating turn, including writes that
    // finish after turn/end. The same definition replays after a page reload.
    const ACTIVITY_EVENT = 'plugin:dsh-hindsight-manager/activity';
    const RECALL_EVENT = 'plugin:dsh-hindsight-manager/recall';
    const OBSERVATION_PROTOCOL = 1;
    const ACTIVITY_KIND = 'hindsight-activity';

    function updateActivity(state, { event }) {
      if (event.type === 'turn/start') return state;
      if (event.type === 'turn/end') return { ...state, endSeq: event.seq };
      if (event.type === RECALL_EVENT || event.type === 'user/message') {
        const record = event.type === RECALL_EVENT ? event.data : null;
        const submission = event.type === 'user/message' ? event.data.source.hindsight : null;
        const id = (record ?? submission).recallId;
        const recalls = [...state.recalls];
        const index = recalls.findIndex((item) => item.id === id);
        const item = index === -1 ? { id, record: null, submission: null } : recalls[index];
        const updated = { ...item, ...(record === null ? { submission } : { record }) };
        if (index === -1) recalls.push(updated);
        else recalls[index] = updated;
        return { ...state, observed: true, recalls, anchorSeq: event.seq };
      }
      const operation = event.data.operation;
      const operations = [...state.operations];
      if (operation !== null) {
        const index = operations.findIndex((item) => item.id === operation.id);
        if (index === -1) operations.push(operation);
        else operations[index] = operation;
      }
      return { ...state, observed: true, operations, anchorSeq: event.seq };
    }

    const activityDefinition = {
      kind: ACTIVITY_KIND,
      target: 'chat',
      match: {
        [ACTIVITY_EVENT]: (event) => ({ id: String(event.data.ownerTurn), role: 'start' }),
        [RECALL_EVENT]: (event) => event.data.protocolVersion === OBSERVATION_PROTOCOL
          ? { id: String(event.data.ownerTurn), role: 'start' } : null,
        'user/message': (event) => event.data.source?.kind === 'plugin:hindsight'
          && event.data.source.hindsight?.protocolVersion === OBSERVATION_PROTOCOL
          ? { id: String(event.data.source.hindsight.ownerTurn), role: 'start' } : null,
        'turn/start': (event) => ({ id: String(event.data.turn), role: 'start' }),
        'turn/end': (event) => ({ id: String(event.data.turn), role: 'start' }),
      },
      start: (_context, match) => updateActivity({
        observed: false,
        turn: Number(match.event.type === 'user/message' ? match.event.data.source.hindsight.ownerTurn
          : [ACTIVITY_EVENT, RECALL_EVENT].includes(match.event.type) ? match.event.data.ownerTurn : match.event.data.turn),
        operations: [],
        recalls: [],
        anchorSeq: match.event.seq,
        endSeq: null,
      }, match),
      update: (context, match) => updateActivity(context.state, match),
      buildViewNode: (context) => {
        const state = context.state;
        if (!state.observed || (state.endSeq === null && state.operations.length === 0 && state.recalls.length === 0)) return null;
        return {
          key: context.key,
          kind: ACTIVITY_KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: state.endSeq ?? state.anchorSeq,
          location: (context.matches.find(({ event }) => event.type === 'turn/start' || event.type === 'turn/end')
            ?? context.matches.find(({ location }) => (location.kind === 'turn' || location.kind === 'step') && location.turn.turn === state.turn)
            ?? context.matches[0]).location,
          groupTree: 'turn',
          visibility: 'visible',
          data: state,
        };
      },
    };

    const displayValue = (value, t) => value === undefined ? t('unknown') : JSON.stringify(value);
    const milliseconds = (value) => `${Math.round(value)} ms`;
    const frequency = (value, t) => value === null ? t('unknown') : value === 0 ? t('frequency_initial') : value === 1 ? t('frequency_every')
      : `${t('frequency_interval')}: ${value}`;

    function Inspection({ inspection, t }) {
      const { runtime, effective, hooksDisabled } = inspection;
      const rows = [[t('status'), t(`runtime_${inspection.status}`)]];
      if (runtime !== null) {
        rows.push([t('runtimeVersion'), runtime.upstreamVersion], [t('patchVersion'), runtime.patchSetVersion]);
        rows.push([t('capabilities'), Object.entries(runtime.capabilities)
          .map(([name, supported]) => `${t(`capability_${name}`)}: ${t(supported ? 'enabled' : 'disabled')}`).join('\n')]);
      }
      if (hooksDisabled !== null) rows.push([t('hooks'), t(hooksDisabled ? 'hooksDisabled' : 'hooksEnabled')]);
      if (effective !== null) rows.push(
        [t('dir'), effective.workspaceRoot],
        [t('bank'), effective.bankId],
        [t('apiUrl'), effective.apiUrl],
        [t('autoInject'), t(`mode_${effective.autoInject}`)],
        [t('autoInjectEveryTurns'), frequency(effective.autoInjectEveryTurns, t)],
        [t('retainSessions'), t(effective.retainSessions ? 'enabled' : 'disabled')],
        [t('injectTimeoutMs'), String(effective.injectTimeoutMs)],
        [t('recallOptions'), displayValue(effective.recallOptions, t)],
      );
      return h('dl', { className: 'hm-values' }, rows.flatMap(([label, value]) => [
        h('dt', { key: `${label}:label` }, label), h('dd', { key: label }, value),
      ]));
    }

    function recallLabel(record) {
      return record.status === 'completed' && record.degraded ? 'recall_degraded' : `recall_${record.status}`;
    }

    function Recall({ item, t }) {
      const { record, submission } = item;
      const body = submission !== null
        ? t(submission.bodyPresent ? 'bodyCommitted' : 'directoryCommitted')
        : record.bodyPresent === true ? `${t('bodyPending')} · ${t('noCommit')}`
          : `${t(record.bodyPresent === false ? 'bodyAbsent' : 'bodyUnknown')} · ${t('noCommit')}`;
      return h('section', { className: 'hm-recall', key: item.id, 'aria-label': t('recallDetails') },
        h('p', null, h('strong', null, record === null ? t('retrievalNotLoaded') : t(recallLabel(record))),
          record !== null && record.totalDurationMs !== null ? ` · ${milliseconds(record.totalDurationMs)}` : null),
        record === null ? null : h('div', null,
          h('details', null, h('summary', null, t('recallConfiguration')), Inspection({ inspection: record.inspection, t })),
          record.skipReason === null ? null : h('p', null, t(`skip_${record.skipReason}`)),
          record.totalDurationMs === null && record.status !== 'skipped' ? h('p', null, t('durationUnknown')) : null,
          h('ol', null, record.stages.map((stage, index) => h('li', { key: index },
            `${t(`mode_${stage.mode}`)} · ${t(`stage_${stage.status}`)} · ${milliseconds(stage.durationMs)}`,
            stage.result === null ? null : ` · ${stage.result.count} ${t(`result_${stage.result.unit}`)}`,
            stage.httpStatus === null ? null : ` · HTTP ${stage.httpStatus}`,
            stage.errorKind === null ? null : ` · ${stage.errorKind}`))),
          record.interruption === null ? null : h('p', null, t(`preparation_${record.interruption.kind}`))),
        h('p', null, `${t('body')}: ${body}`));
    }

    function Activity({ node, t }) {
      const { operations, recalls } = node.data;
      if (operations.length === 0 && recalls.length === 0) {
        return h('div', { className: 'hm-activity', 'data-status': 'unused' }, `Hindsight · ${t('activityUnused')}`);
      }
      const records = recalls.flatMap((item) => item.record === null ? [] : [item.record]);
      const status = operations.some((item) => item.status === 'running') || records.some((item) => item.status === 'running') ? 'running'
        : operations.some((item) => item.status === 'failed') || records.some((item) => item.status === 'failed' || item.interruption?.kind === 'failed') ? 'failed' : 'called';
      let label = { running: 'activityRunning', failed: 'activityFailed', called: 'activityCalled' }[status];
      if (status === 'called' && recalls.length > 0) {
        if (records.some((item) => item.status === 'completed' && item.degraded)) label = 'recall_degraded';
        else if (records.some((item) => item.status === 'completed')) label = 'recall_completed';
        else if (operations.length === 0) {
          if (records.some((item) => item.status === 'cancelled')) label = 'recall_cancelled';
          else if (records.some((item) => item.status === 'empty')) label = 'recall_empty';
          else if (records.length > 0) label = 'recall_skipped';
          else label = 'recall_submitted';
        }
      }
      return h('details', { className: 'hm-activity', 'data-status': status },
        h('summary', null, h('span', { 'aria-hidden': true }, '🧠 '),
          h('span', { role: 'status' }, `Hindsight · ${t(label)}`)),
        recalls.map((item) => Recall({ item, t })),
        h('ul', null, operations.map((item) => h('li', { key: item.id },
          h('span', null, item.action.startsWith('hindsight_') ? item.action : t(item.action)),
          h('span', null, `· ${t(item.status)}`)))),
      );
    }

    function RuntimeStatus({ sessionId, t }) {
      const [open, setOpen] = useState(false);
      const [revision, setRevision] = useState(0);
      const [query, setQuery] = useState(null);
      const dialog = useRef(null);

      useEffect(() => {
        if (open) dialog.current.showModal();
        else dialog.current.close();
      }, [open]);

      useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        setQuery(null);
        const read = async () => {
          try {
            const response = await fetch(`${ROUTES.runtime}?sessionId=${encodeURIComponent(sessionId)}`, {
              credentials: 'same-origin', signal: controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const inspection = await response.json();
            if (!controller.signal.aborted) setQuery({ sessionId, inspection, error: null, readAt: new Date() });
          } catch (error) {
            if (!controller.signal.aborted) setQuery({ sessionId, inspection: null, error: error.message, readAt: null });
          }
        };
        read();
        return () => controller.abort();
      }, [open, sessionId, revision]);

      const current = query?.sessionId === sessionId ? query : null;
      return h('div', null,
        h('button', { className: 'hm-btn', type: 'button', 'aria-haspopup': 'dialog',
          'aria-label': t('runtimeTitle'), onClick: () => setOpen(true) }, 'Hindsight'),
        h('dialog', { ref: dialog, className: 'hm-runtime-dialog', 'aria-label': t('runtimeTitle'),
          onClose: () => setOpen(false) },
          h('div', { className: 'hm-runtime-title' }, h('h2', { className: 'hm-h' }, t('runtimeTitle')),
            h('button', { className: 'hm-btn', type: 'button', onClick: () => setOpen(false) }, t('close'))),
          h('p', { className: 'hm-sub' }, t('runtimeLiveNote')),
          current === null ? h('p', { role: 'status' }, t('loading'))
            : current.error !== null ? h('p', { role: 'alert' }, `${t('runtimeError')}: ${current.error}`)
              : Inspection({ inspection: current.inspection, t }),
          h('div', { className: 'hm-row' },
            h('button', { className: 'hm-btn', type: 'button', disabled: current === null,
              onClick: () => setRevision((value) => value + 1) }, t('reload')),
            current?.readAt ? h('span', { className: 'hm-sub' }, `${t('runtimeReadAt')}: `,
              h('time', { dateTime: current.readAt.toISOString() }, current.readAt.toLocaleString())) : null)));
    }

    // -- page -----------------------------------------------------------------

    const EMPTY_LIST = Object.freeze([]);
    const selectWorkspaceItems = (snapshot) =>
      snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.items) ? snapshot.items : EMPTY_LIST;

    function Page(props) {
      const t = props.t ?? ((key) => zh[key] ?? key);
      // 宿主在 settings.section 上注入的标准 prop：已登记的工作区，作为快速选择
      const workspaceItems =
        typeof props.useWorkspaces === 'function' ? props.useWorkspaces(selectWorkspaceItems) : EMPTY_LIST;
      const [state, setState] = useState(undefined);
      const [error, setError] = useState(undefined);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(undefined);
      const [probe, setProbe] = useState(undefined);
      const [bankList, setBankList] = useState(undefined);
      const [draft, setDraft] = useState(undefined);
      const [baseline, setBaseline] = useState(undefined);
      const [inherit, setInherit] = useState([]);
      const nextRowId = useRef(0);

      const numberText = (value) => typeof value === 'object' ? JSON.stringify(value) : String(value);
      const makeDraft = (body) => ({
          apiUrl: body.apiUrl,
          positions: body.positions.map((row) => ({ id: nextRowId.current++, dir: row.dir, bank: row.bank })),
          optInOnly: body.optInOnly,
          optInPaths: JSON.stringify(body.optInPaths),
          retainSessions: body.retainSessions,
          autoInject: body.autoInject,
          autoInjectEveryTurns: numberText(body.autoInjectEveryTurns),
          injectTimeoutMs: numberText(body.injectTimeoutMs),
          recallOptions: {
            budget: body.recallOptions.budget,
            max_tokens: numberText(body.recallOptions.max_tokens),
            types: JSON.stringify(body.recallOptions.types),
          },
      });

      const acceptSettings = (body) => {
        const next = makeDraft(body);
        setState(body);
        setDraft(next);
        setBaseline(next);
        setInherit([]);
      };

      const load = useCallback(async () => {
        setError(undefined);
        try {
          const response = await fetch(ROUTES.state, { credentials: 'same-origin' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          acceptSettings(body);
        } catch (loadError) {
          setError(String(loadError?.message ?? loadError));
        }
      }, []);

      useEffect(() => {
        void load();
      }, [load]);


      const runProbe = async () => {
        setProbe(undefined);
        try {
          const response = await fetch(ROUTES.test, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
          setProbe(await response.json());
        } catch (probeError) {
          setProbe({ ok: false, error: String(probeError?.message ?? probeError) });
        }
      };

      const loadBanks = async () => {
        try {
          const response = await fetch(ROUTES.banks, { credentials: 'same-origin' });
          const body = await response.json();
          setBankList(body);
        } catch (banksError) {
          setBankList({ ok: false, error: String(banksError?.message ?? banksError), banks: [] });
        }
      };

      const changes = () => {
        const set = {};
        for (const key of ['apiUrl', 'optInOnly', 'optInPaths', 'retainSessions', 'autoInject', 'autoInjectEveryTurns', 'injectTimeoutMs']) {
          const group = key === 'apiUrl' ? 'connection' : key;
          if (!inherit.includes(group) && draft[key] !== baseline[key]) set[key] = draft[key];
        }
        const positions = draft.positions.map(({ dir, bank }) => ({ dir, bank }));
        if (!inherit.includes('positions') && JSON.stringify(positions) !== JSON.stringify(baseline.positions.map(({ dir, bank }) => ({ dir, bank })))) {
          set.positions = positions;
        }
        if (!inherit.includes('recallOptions')) {
          for (const key of ['budget', 'max_tokens', 'types']) {
            if (draft.recallOptions[key] !== baseline.recallOptions[key]) {
              set.recallOptions = { ...set.recallOptions, [key]: draft.recallOptions[key] };
            }
          }
        }
        return { set, inherit };
      };

      const parseNumber = (value, name) => {
        const number = Number(value);
        if (value.trim() === '' || !Number.isInteger(number) || number < 0) {
          throw new Error(`${name}: ${t('invalidNumber')}`);
        }
        return number;
      };

      const parseArray = (value, name, allowNull = false) => {
        let parsed;
        try {
          parsed = JSON.parse(value);
        } catch {
          throw new Error(`${name}: ${t('invalidArray')}`);
        }
        if (allowNull && parsed === null) return null;
        if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
          throw new Error(`${name}: ${t('invalidArray')}`);
        }
        return parsed;
      };

      const save = async () => {
        const operation = changes();
        if (Object.keys(operation.set).length === 0 && operation.inherit.length === 0) return;
        setBusy(true);
        setNotice(undefined);
        try {
          if ('apiUrl' in operation.set) {
            operation.set.apiUrl = operation.set.apiUrl.trim();
            if (operation.set.apiUrl === state.apiUrl) delete operation.set.apiUrl;
          }
          if ('positions' in operation.set) {
            operation.set.positions = operation.set.positions.map(({ dir, bank }) => ({ dir, bank: bank.trim() }));
            if (JSON.stringify(operation.set.positions) === JSON.stringify(state.positions.map(({ dir, bank }) => ({ dir, bank })))) {
              delete operation.set.positions;
            }
          }
          for (const key of ['autoInjectEveryTurns', 'injectTimeoutMs']) {
            if (key in operation.set) operation.set[key] = parseNumber(operation.set[key], t(key));
          }
          if ('optInPaths' in operation.set) operation.set.optInPaths = parseArray(operation.set.optInPaths, t('optInPaths'));
          if (operation.set.recallOptions) {
            const options = operation.set.recallOptions;
            if ('max_tokens' in options) options.max_tokens = parseNumber(options.max_tokens, t('maxTokens'));
            if ('types' in options) options.types = parseArray(options.types, t('types'), true);
            for (const key of Object.keys(options)) {
              if (JSON.stringify(options[key]) === JSON.stringify(state.recallOptions[key])) delete options[key];
            }
            if (Object.keys(options).length === 0) delete operation.set.recallOptions;
          }
          for (const key of ['autoInjectEveryTurns', 'injectTimeoutMs', 'optInPaths']) {
            if (key in operation.set && JSON.stringify(operation.set[key]) === JSON.stringify(state[key])) delete operation.set[key];
          }
          if (Object.keys(operation.set).length === 0 && operation.inherit.length === 0) {
            acceptSettings(state);
            return;
          }
          const response = await fetch(ROUTES.save, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(operation),
          });
          const body = await response.json();
          if (!response.ok || body.ok === false) {
            setNotice({ ok: false, text: body.error ?? `HTTP ${response.status}` });
          } else {
            setNotice({ ok: true, text: t('saved') });
            acceptSettings(body.settings);
          }
        } catch (saveError) {
          setNotice({ ok: false, text: String(saveError?.message ?? saveError) });
        } finally {
          setBusy(false);
        }
      };

      const edit = (key, value, group = key) => {
        setInherit((current) => current.filter((item) => item !== group));
        setDraft((current) => ({ ...current, [key]: value }));
        setNotice(undefined);
      };

      const editRecall = (key, value) => {
        setInherit((current) => current.filter((item) => item !== 'recallOptions'));
        setDraft((current) => ({ ...current, recallOptions: {
          ...(inherit.includes('recallOptions') ? baseline.recallOptions : current.recallOptions), [key]: value,
        } }));
        setNotice(undefined);
      };

      const restoreGroup = (group) => {
        const inherited = makeDraft(state.inherited);
        const key = group === 'connection' ? 'apiUrl' : group;
        setDraft((current) => ({ ...current, [key]: inherited[key] }));
        setInherit((current) => [...current.filter((item) => item !== group), group]);
        setNotice(undefined);
      };

      const patchRow = (index, key, value) => {
        setInherit((current) => current.filter((item) => item !== 'positions'));
        setDraft((current) => {
          const positions = current.positions.map((row, position) =>
            position === index ? { ...row, [key]: value } : row
          );
          return { ...current, positions };
        });
      };

      const addRow = (dir, bank) => {
        setInherit((current) => current.filter((item) => item !== 'positions'));
        const row = { id: nextRowId.current++, dir: dir ?? '', bank: bank ?? '' };
        setDraft((current) => ({ ...current, positions: [...current.positions, row] }));
      };

      const removeRow = (index) => {
        setInherit((current) => current.filter((item) => item !== 'positions'));
        setDraft((current) => ({ ...current, positions: current.positions.filter((_, position) => position !== index) }));
      };

      if (error !== undefined) {
        return h('div', { className: 'hm-root' }, h('div', { className: 'hm-note hm-note-bad' }, `${t('errorLoading')}: ${error}`));
      }
      if (state === undefined || draft === undefined) {
        return h('div', { className: 'hm-root' }, h('div', { className: 'hm-empty' }, t('loading')));
      }

      const knownBanks = bankList?.banks ?? [];
      const datalistId = 'hm-bank-list';
      const operation = changes();
      const hasChanges = Object.keys(operation.set).length > 0 || inherit.length > 0;
      const frequencySupported = state.enhancement.status === 'declared' && state.enhancement.autoInjectEveryTurns;

      const origin = (group, keys = [group]) => {
        const restoring = inherit.includes(group);
        const overridden = keys.some((key) => state.overrides[key]);
        const changed = keys.some((key) => key in operation.set);
        return h('div', { className: 'hm-origin' },
          h('span', { className: 'hm-badge hm-muted' }, t(restoring ? 'pendingInherit' : changed ? 'pendingEdit' : overridden ? 'explicit' : 'inherit')),
          restoring && group === 'recallOptions' ? h('span', null, t('restoreEditHint')) : null,
          restoring ? null : keys.map((key) => h('span', { key }, `${t('source')} ${key}: ${t(`source_${state.sources[key].layer}`)} (${state.sources[key].key})`)),
          overridden && !restoring
            ? h('button', { className: 'hm-btn', 'data-inherit': group, onClick: () => restoreGroup(group), disabled: busy }, t('restore'))
            : null,
        );
      };

      const configuredNote = (key) => Object.hasOwn(state.configured, key) &&
        (JSON.stringify(state.configured[key]) !== JSON.stringify(state[key]) ||
          (['optInOnly', 'retainSessions'].includes(key) && typeof state[key] !== 'boolean'))
        ? h('p', { className: 'hm-sub' }, `${t('configuredValue')} (${key}): ${JSON.stringify(state.configured[key])} · ${t('effectiveValue')}: ${JSON.stringify(state[key])}. ${t('preserveValue')}`)
        : null;

      const selectOptions = (options, current, label) => {
        const values = options.includes(current) ? options : [current, ...options];
        return values.map((value) => h('option', { key: value, value }, label ? t(`${label}${value}`) : value));
      };
      const budgetIsString = typeof draft.recallOptions.budget === 'string';
      const budgetOptions = budgetIsString
        ? selectOptions(state.options.recallBudgets, draft.recallOptions.budget)
        : [
          h('option', { key: CONFIGURED_BUDGET_OPTION, value: CONFIGURED_BUDGET_OPTION, disabled: true },
            `${t('configuredValue')}: ${numberText(draft.recallOptions.budget)}`),
          ...state.options.recallBudgets.map((value) => h('option', { key: value, value }, value)),
        ];

      return h(
        'div',
        { className: 'hm-root' },
        h('p', { className: 'hm-sub', style: { margin: 0 } }, t('intro')),
        h('p', { className: 'hm-sub', style: { margin: 0 } }, t('scope')),

        // 连接
        h(
          'div',
          { className: 'hm-card' },
          h('p', { className: 'hm-h' }, t('connection')),
          origin('connection', ['apiUrl', 'serverMode', 'apiPort']),
          configuredNote('apiUrl'),
          configuredNote('serverMode'),
          configuredNote('apiPort'),
          h('p', { className: 'hm-sub' }, t('apiUrlHint')),
          h(
            'div',
            { className: 'hm-row' },
            h('input', {
              name: 'apiUrl',
              className: 'hm-input hm-mono',
              value: draft.apiUrl,
              'aria-label': t('apiUrl'),
              onChange: (event) => edit('apiUrl', event.target.value, 'connection'),
            }),
            h('button', { className: 'hm-btn', onClick: runProbe, disabled: busy }, t('test')),
          ),
          h('p', { className: 'hm-sub' }, `${t('serverMode')}: ${(inherit.includes('connection') ? state.inherited : state).serverMode} · ${t('apiPort')}: ${(inherit.includes('connection') ? state.inherited : state).apiPort} · ${t(state.apiTokenConfigured ? 'tokenConfigured' : 'tokenMissing')}`),
          probe !== undefined
            ? h(
                'div',
                { className: `hm-note ${probe.ok ? 'hm-note-ok' : 'hm-note-bad'}`, style: { marginTop: 10 } },
                probe.ok
                  ? `OK · bank=${probe.bank}${probe.documents === undefined ? '' : ` · documents=${probe.documents}`}`
                  : `失败：${probe.error ?? 'unknown'}`
              )
            : null,
          h('div', { className: 'hm-sub hm-mono', style: { marginTop: 10, marginBottom: 0 } }, state.configPath),
        ),

        // 工作区映射
        h(
          'div',
          { className: 'hm-card' },
          h(
            'div',
            { className: 'hm-row', style: { justifyContent: 'space-between', marginBottom: 4 } },
            h('p', { className: 'hm-h', style: { margin: 0 } }, t('banks')),
            h(
              'div',
              { className: 'hm-row' },
              h('button', { className: 'hm-btn', onClick: loadBanks }, t('refreshBanks')),
              h('button', { className: 'hm-btn', onClick: () => addRow() }, t('add')),
            ),
          ),
          h('p', { className: 'hm-sub' }, t('banksHint')),
          origin('positions'),

          // 已登记工作区的快捷入口：一键加入映射
          workspaceItems.length > 0
            ? h(
                'div',
                { className: 'hm-row', style: { flexWrap: 'wrap', marginBottom: 10 } },
                workspaceItems
                  .map((item) => item?.path ?? item?.dir ?? item?.cwd)
                  .filter((dir) => typeof dir === 'string' && dir.length)
                  .filter((dir) => !draft.positions.some((row) => row.dir === dir))
                  .map((dir) =>
                    h(
                      'button',
                      {
                        key: dir,
                        className: 'hm-btn hm-mono',
                        title: dir,
                        style: { fontSize: 11, padding: '4px 9px' },
                        onClick: () => addRow(dir, ''),
                      },
                      `+ ${dir.split('/').filter(Boolean).pop() ?? dir}`,
                    )
                  ),
              )
            : null,

          h(
            'datalist',
            { id: datalistId },
            knownBanks.map((bank) => h('option', { key: bank, value: bank })),
          ),

          draft.positions.length === 0
            ? h('div', { className: 'hm-empty' }, t('notMapped'))
            : h(
                'div',
                { className: 'hm-list' },
                draft.positions.map((row, index) =>
                  h(
                    'div',
                    { className: 'hm-item', key: row.id },
                    h('input', {
                      className: 'hm-input hm-mono',
                      value: row.dir,
                      placeholder: t('enterPath'),
                      onChange: (event) => patchRow(index, 'dir', event.target.value),
                    }),
                    h('input', {
                      className: 'hm-input hm-mono',
                      value: row.bank,
                      placeholder: t('bankPlaceholder'),
                      list: datalistId,
                      onChange: (event) => patchRow(index, 'bank', event.target.value),
                    }),
                    h(
                      'span',
                      {
                        className: 'hm-badge hm-muted',
                        title: row.dir,
                      },
                      state.positions.find((entry) => entry.dir === row.dir)?.exists === true
                        ? t('exists')
                        : state.positions.find((entry) => entry.dir === row.dir)?.exists === false
                          ? t('missing')
                          : t('unchecked'),
                    ),
                    h(
                      'button',
                      { className: 'hm-btn hm-btn-danger', onClick: () => removeRow(index) },
                      t('remove'),
                    ),
                  )
                )
              ),

          bankList !== undefined && !bankList.ok
            ? h('div', { className: 'hm-sub', style: { marginTop: 8, marginBottom: 0 } }, `${t('unknownBanks')}: ${bankList.error}`)
            : null,
          bankList?.ok
            ? h('p', { className: 'hm-sub' }, `${t('banksPage')}: ${bankList.banks.length} / ${bankList.total}`)
            : null,
        ),

        // 选项
        h(
          'div',
          { className: 'hm-card' },
          h('p', { className: 'hm-h' }, t('options')),
          origin('optInOnly'),
          configuredNote('optInOnly'),
          h(
            'label',
            { className: 'hm-check' },
            h('input', {
              type: 'checkbox',
              name: 'optInOnly',
              checked: draft.optInOnly,
              onChange: (event) => edit('optInOnly', event.target.checked),
            }),
            h('span', null, h('strong', null, t('optInOnly')), h('br'), h('span', { className: 'hm-sub' }, t('optInOnlyHint'))),
          ),
          h('div', { className: 'hm-field' },
            h('label', { htmlFor: 'hm-opt-in-paths' }, t('optInPaths')),
            origin('optInPaths'),
            configuredNote('optInPaths'),
            h('textarea', { id: 'hm-opt-in-paths', name: 'optInPaths', className: 'hm-input hm-mono', value: draft.optInPaths,
              onChange: (event) => edit('optInPaths', event.target.value) }),
            h('p', { className: 'hm-sub' }, t('optInPathsHint')),
          ),
        ),

        h('div', { className: 'hm-card' },
          h('p', { className: 'hm-h' }, t('common')),
          h('div', { className: 'hm-field' },
            h('label', { htmlFor: 'hm-auto-inject' }, t('autoInject')),
            origin('autoInject'),
            configuredNote('autoInject'),
            h('select', { id: 'hm-auto-inject', name: 'autoInject', className: 'hm-input', value: draft.autoInject,
              onChange: (event) => edit('autoInject', event.target.value) },
              selectOptions(state.options.autoInjectModes, draft.autoInject, 'mode_')),
            h('p', { className: 'hm-sub' }, t('autoInjectHint')),
          ),
          h('div', { className: 'hm-field' },
            h('label', { htmlFor: 'hm-frequency' }, t('autoInjectEveryTurns')),
            origin('autoInjectEveryTurns'),
            configuredNote('autoInjectEveryTurns'),
            h('input', { id: 'hm-frequency', name: 'autoInjectEveryTurns', type: 'text', inputMode: 'numeric',
              className: 'hm-input', value: draft.autoInjectEveryTurns, disabled: !frequencySupported,
              onChange: (event) => edit('autoInjectEveryTurns', event.target.value) }),
            h('p', { className: 'hm-sub' }, t('frequencyHint')),
            h('p', { className: 'hm-sub' }, t('frequencyCostHint')),
            h('p', { className: 'hm-sub' }, state.enhancement.status === 'error'
              ? `${t('enhancementError')}: ${state.enhancement.error}`
              : `${t(frequencySupported ? 'enhancementDeclared' : state.enhancement.status === 'unlinked' ? 'enhancementUnlinked' : 'enhancementUndeclared')}${state.enhancement.status === 'declared' ? ` · ${state.enhancement.upstreamVersion} / ${state.enhancement.patchSetVersion}` : ''}`),
            h('p', { className: 'hm-sub' }, t('enhancementInstalledOnly')),
          ),
          origin('retainSessions'),
          configuredNote('retainSessions'),
          h(
            'label',
            { className: 'hm-check', style: { marginTop: 10 } },
            h('input', {
              type: 'checkbox',
              name: 'retainSessions',
              checked: draft.retainSessions,
              onChange: (event) => edit('retainSessions', event.target.checked),
            }),
            h('span', null, t('retainSessions')),
          ),
          h('p', { className: 'hm-sub' }, t('retainSessionsHint')),
        ),

        h('details', { className: 'hm-card' },
          h('summary', { className: 'hm-summary' }, t('advanced')),
          h('p', { className: 'hm-sub', style: { marginTop: 10 } }, t('recallFallbackHint')),
          origin('recallOptions'),
          configuredNote('recallOptions'),
          h('div', { className: 'hm-field' },
            h('label', { htmlFor: 'hm-budget' }, t('budget')),
            h('select', { id: 'hm-budget', name: 'recallOptions.budget', className: 'hm-input',
              value: budgetIsString ? draft.recallOptions.budget : CONFIGURED_BUDGET_OPTION,
              onChange: (event) => editRecall('budget', event.target.value) }, budgetOptions),
            h('p', { className: 'hm-sub' }, t('budgetHint')),
          ),
          h('div', { className: 'hm-field' },
            h('label', { htmlFor: 'hm-max-tokens' }, t('maxTokens')),
            h('input', { id: 'hm-max-tokens', name: 'recallOptions.max_tokens', type: 'text', inputMode: 'numeric',
              className: 'hm-input', value: draft.recallOptions.max_tokens, onChange: (event) => editRecall('max_tokens', event.target.value) }),
            h('p', { className: 'hm-sub' }, t('maxTokensHint')),
          ),
          h('div', { className: 'hm-field' },
            h('label', { htmlFor: 'hm-types' }, t('types')),
            h('label', { className: 'hm-check' },
              h('input', { type: 'checkbox', name: 'recallOptions.allTypes', checked: draft.recallOptions.types === 'null',
                onChange: (event) => editRecall('types', event.target.checked ? 'null' : '[]') }),
              t('allTypes'),
            ),
            h('textarea', { id: 'hm-types', name: 'recallOptions.types', className: 'hm-input hm-mono',
              value: draft.recallOptions.types, disabled: draft.recallOptions.types === 'null',
              onChange: (event) => editRecall('types', event.target.value) }),
            h('p', { className: 'hm-sub' }, `${t('typesHint')} ${state.options.recallTypes.join(', ')}`),
            h('p', { className: 'hm-sub' }, t('typesMeaning')),
          ),
          h('div', { className: 'hm-field' },
            h('label', { htmlFor: 'hm-timeout' }, t('injectTimeoutMs')),
            origin('injectTimeoutMs'),
            configuredNote('injectTimeoutMs'),
            h('input', { id: 'hm-timeout', name: 'injectTimeoutMs', type: 'text', inputMode: 'numeric',
              className: 'hm-input', value: draft.injectTimeoutMs, onChange: (event) => edit('injectTimeoutMs', event.target.value) }),
            h('p', { className: 'hm-sub' }, t('timeoutHint')),
          ),
        ),

        // 操作
        h(
          'div',
          { className: 'hm-row' },
          h('button', { className: 'hm-btn hm-btn-primary', onClick: save, disabled: busy || !hasChanges }, busy ? t('saving') : t('save')),
          h('button', { className: 'hm-btn', onClick: load, disabled: busy }, t('reload')),
          notice !== undefined
            ? h('span', { className: `hm-badge ${notice.ok ? 'hm-ok' : 'hm-bad'}` }, notice.text)
            : null,
        ),
        h('p', { className: 'hm-sub', style: { margin: 0 } }, t('restNote')),
      );
    }

    // -- plugin entry ---------------------------------------------------------

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.plugin = NS;
        style.textContent = STYLE;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'hindsight-manager: styles');

      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'hindsight-manager: dictionaries');
      } catch {
        /* locale 不可用就退回内置中文 */
      }
      const t = (() => {
        try {
          return ctx.locale.bind(NS);
        } catch {
          return (key) => zh[key] ?? key;
        }
      })();

      ctx.inject(['uiConversation'], (owner) => {
        owner.effect(() => owner.uiConversation.events.register(activityDefinition), 'hindsight-manager: activity view');
        owner.slots.inject('conversation.chat.node', () => owner.slots.register({
          name: 'conversation.chat.node',
          key: ACTIVITY_KIND,
          inject: () => ({ t }),
        }, Activity));
        owner.slots.inject('conversation.session.header.utilities', () => owner.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'hindsight-runtime-status',
          inject: () => ({ t }),
        }, RuntimeStatus));
      });

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: NS,
            order: 17,
            label: () => t('title'),
            locale: NS,
            inject: () => ({ t }),
          },
          Page,
        ),
      );
    }

    exports.name = NS;
    exports.inject = inject;
    exports.apply = apply;
    exports.Page = Page;
    return module.exports;
  },
});
