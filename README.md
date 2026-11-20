# dsh-hindsight-manager

为 DSH 插件市场中的官方 `@vectorize-io/hindsight-coding-agents` 提供配置面板。
官方插件负责记忆工具、检索、上下文注入、会话回写和自身版本更新；管理器负责服务地址、
工作区到记忆库的映射、启用范围与回写选项。

管理器通过读写官方配置文件协作，不导入或自动修改官方运行时，不注册记忆工具或订阅
Agent 会话事件。两个插件安装在同一个 DSH profile 中，分别通过插件市场或插件管理命令更新。
本仓库不跟踪上游版本，也没有上游同步定时任务。

仓库另附[每轮主动召回的运行时补丁](runtime-patches/README.md)，将每个用户回合的自动检索、
上下文注入和回复后的自动保存连成长期记忆闭环。补丁针对官方插件 `0.8.7`，包含配置文件和
回归测试，可离线应用。**只更新管理器不会自动启用这项能力**，请按补丁说明应用并重启 DSH。

已验证管理器的宿主加载与配置接口：**DSH 0.2.2-rc.1**，需要 **Node.js ≥ 24.9.0**。
官方记忆插件与 DSH、Hindsight 服务的版本兼容性遵循官方说明。

## 安装

先在 DSH 插件市场安装并启用 **`@vectorize-io/hindsight-coding-agents`**，再安装本管理器。
在有网络和仓库访问权限的机器上，也可以使用：

```bash
dsh plugin --profile web add @vectorize-io/hindsight-coding-agents
dsh plugin --profile web add github:moshangssh/dsh-hindsight-manager
```

将 `web` 换成实际使用的 profile。重新加载 DSH 并刷新浏览器后，设置页会出现
**Hindsight 记忆** 面板。Hindsight 服务需另行准备，并能从 DSH 所在机器访问。

部署机器不能连接外网时，在开发机器进入本仓库执行 `npm pack`，传入安装包：

```bash
dsh plugin --profile web add ./dsh-hindsight-manager-0.2.2.tgz --offline
```

这个安装包包含管理界面及可手动应用的运行时补丁。Node.js、DSH、官方 Hindsight 插件和可访问的 Hindsight 服务
需要预先准备；官方插件按 DSH 提供的离线包或缓存安装方式部署。

## 配置与生效

面板读写 `~/.hindsight/coding-agent.json`。读取时由 `harnesses.dsh` 覆盖顶层同名字段，
保存时只更新 `harnesses.dsh` 中提交的设置；其他助手、`paths`、`banks`、Token 等已有配置保留。

例如，已有自建服务可以这样配置：

```json
{
  "serverMode": "self-hosted",
  "apiUrl": "http://127.0.0.1:8888",
  "harnesses": {
    "dsh": {
      "optInOnly": true,
      "mapPathToBank": {
        "/path/to/project": "project-memory"
      },
      "autoInject": "recall",
      "retainSessions": true
    }
  }
}
```

`apiUrl` 填 REST 根地址，不带 `/mcp`。服务需要认证时，在顶层或 `harnesses.dsh` 中设置
`apiToken`；面板的连接测试和库列表请求会使用该 Token，页面只显示是否已配置。
已有 daemon 配置时，保存其他设置会保留 daemon 模式；将服务地址改为另一地址并保存时，
DSH 配置切换为 `self-hosted`，重启后使用新地址。
连接测试使用第一个已保存的工作区映射。页面中的目录状态表示目录是否存在，记忆库的运行时
解析由官方插件负责；`paths`、`banks` 等高级覆盖继续在官方配置文件中管理。

**保存后请重启 DSH，让官方插件读取新配置。** 管理器不会调用官方内部 API 刷新运行时。
重新读取按钮、测试连接、刷新库列表均使用磁盘上已经保存的配置。

管理器自身参数集中在根目录 `manager.config.json`，包含配置文件路径、请求超时和表单初始值。
表单初始值用于文件未设置对应字段时显示，不会在打开页面时写入文件。若使用自定义配置路径，
确保管理器的 `configPath` 和官方插件实际读取的路径一致。

## 从 0.1.0 迁移

0.1.0 内置了修改过的 Hindsight 运行时；0.2.0 将记忆运行交回官方插件：

1. 在同一个 profile 安装并启用官方 `@vectorize-io/hindsight-coding-agents`。
2. 将管理器更新到 0.2.0。
3. 如果先前按旧版说明在 `cordis.patch.yml` 中设置了 `id: hindsight` 的 `disabled: true`，
   移除该禁用设置，或将其改为 `false`。
4. 重启 DSH 并刷新浏览器。

原有 `coding-agent.json` 和 Hindsight 服务端记忆库继续使用。管理器不会自动应用官方
运行时兼容补丁；需要本地修订时，使用仓库的 `runtime-patches/` 中的补丁和说明。

卸载管理器只移除设置面板，官方记忆插件仍可独立使用：

```bash
dsh plugin --profile web remove dsh-hindsight-manager
```

## 开发与验证

安装 `package.json` 声明的 DSH 版本，并让 `dsh` 位于 PATH，然后执行：

```bash
npm run check
npm test
```

测试覆盖配置继承与保存、服务连接、真实 Cordis 生命周期及独立安装包加载。
HTTP 使用替身，配置使用临时目录，无需安装官方记忆运行时。GitHub Actions 在推送、PR 或手动
运行时检查本管理器，不下载或同步上游代码。

## 许可证

MIT。
