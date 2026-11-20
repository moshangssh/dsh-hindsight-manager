# 每轮主动召回的运行时补丁

这组补丁将本地验证过的主动记忆改动保存在管理器仓库中，应用对象是
`@vectorize-io/hindsight-coding-agents` **0.8.7** 的发布目录，已验证宿主为
DSH **0.2.2-rc.1**。管理器仍负责设置；补丁修改的是官方插件的 DSH 运行时。
只更新管理器不会自动应用补丁，也不会改变官方插件的召回频率。

## 行为

1. 每次用户发来消息，按当前问题检索 Hindsight，在模型回答前注入结果。
2. 同一轮中执行工具的后续步骤不重复召回。
3. 回复结束后自动保存对话，由 Hindsight 异步提取、归纳记忆。
4. 后续回合和新会话继续检索；空库或上次请求失败不会关闭后续召回。
5. 即使结果与上一轮相同，也重新注入，避免旧记忆被上下文压缩移除后缺失。

记忆范围由已有 bank 配置决定。检索采用同步调用，会增加一次查询耗时；新写入的内容
需要服务端处理完成后才能被检索。自动保存排除插件注入的记忆文本。

## 补丁内容

- `0001-dsh-compatibility.patch`：DSH 生命周期、会话工具注册、配置刷新、请求取消和卸载修复，
  以及这些行为的回归测试。主动记忆改动基于这一版适配器。
- `0002-active-memory.patch`：每轮召回、根目录参数文件、使用说明、技能说明和主动记忆测试。

这两份补丁只调整 DSH 适配器；其他助手的运行时代码保持上游行为。

## 离线应用

先准备官方插件 0.8.7 的完整发布目录、Node.js、DSH 和可访问的 Hindsight 服务。
以下命令不下载依赖，也不调用真实记忆服务。将路径替换成实际目录：

```bash
manager_repo=/absolute/path/to/dsh-hindsight-manager
hindsight_package=/absolute/path/to/hindsight-coding-agents

git -C "$hindsight_package" apply "$manager_repo/runtime-patches/0001-dsh-compatibility.patch"
git -C "$hindsight_package" apply "$manager_repo/runtime-patches/0002-active-memory.patch"
npm --prefix "$hindsight_package" run test:dsh
```

如果目标已应用过本仓库的第一份兼容补丁，只应用第二份。已经包含两份补丁的本地目录
无需再次应用。不要把这些补丁应用到管理器目录。

完成后重启加载该官方插件目录的 DSH。管理器在面板中保存的服务地址、工作区映射等配置
继续使用；管理器本身无需注册另一套记忆工具或会话钩子。

## 参数

第二份补丁在**官方插件包根目录**创建 `dsh-memory.config.json`：

```json
{
  "autoInject": "recall",
  "autoInjectEveryTurns": 1,
  "injectTimeoutMs": 7000,
  "recallOptions": {
    "types": ["observation", "world", "experience"],
    "budget": "low",
    "max_tokens": 2000
  },
  "retainSessions": true,
  "autoUpdate": false
}
```

`autoInjectEveryTurns: 1` 表示每个用户回合召回；正整数 N 表示第 1、1+N、1+2N 回合召回；
`0` 使用原来的会话首次召回逻辑。`autoInject: "none"` 关闭自动召回。

根目录文件提供 DSH 默认值，`~/.hindsight/coding-agent.json` 的显式字段、`harnesses.dsh`、
`paths` 和 `banks` 设置继续覆盖它。新增频率参数不通过环境变量注入。
修改参数后重启 DSH。完整配置优先级和行为说明也写入了官方插件的 README。

## 验证与更新

补丁附带 25 项独立运行时测试：适配器 8 项、请求取消 11 项、主动记忆 6 项。
其中主动记忆测试覆盖换话题、空库后新增记忆、跨会话自动保存与召回、取消、频率设置及 bank
隔离。HTTP 使用模拟响应，不向真实 Hindsight 写入测试内容。

这组补丁针对发布产物，当前目录不包含上游 TypeScript 构建工程。重新安装或重新构建
官方插件会覆盖修改；升级上游版本后需要重新核对补丁，不能直接假定适用于其他版本。
管理器不会在后台下载、更新或重打这些补丁。
