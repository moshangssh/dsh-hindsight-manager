# dsh-hindsight-manager

为 DeepSeek Harness 提供按工作区隔离的 Hindsight 记忆工具、自动召回、会话回写，以及设置面板。

已验证 **DSH 0.2.2-rc.1**，需要 Node.js **24.9.0 或以上**。这是独立的 Cordis bundle，
通过 `package.json` 的 `dsh.bundle.patch` 加载。修订后的 Hindsight 0.8.7 运行时随包交付，
安装时无需构建，也不依赖开发机器上的绝对路径或符号链接。

## 安装

在已配置仓库访问权限的机器上：

```bash
dsh plugin --profile web add github:moshangssh/dsh-hindsight-manager
```

也可以安装本地 checkout：

```bash
dsh plugin --profile web add ./dsh-hindsight-manager
```

部署机器不能连接外网时，在开发机器生成包含全部运行文件的包，将文件传入部署机器：

```bash
npm pack
# 在部署机器执行：
dsh plugin --profile web add ./dsh-hindsight-manager-0.1.0.tgz --offline
```

安装后重新加载插件并刷新浏览器。设置页中的 **Hindsight 记忆** 面板可以编辑工作区映射和
Hindsight 服务地址。Hindsight 服务须预先部署并能从宿主访问，服务不包含在本插件中。

### 从先前的本地管理器迁移

本包替代原来的 `dsh-hindsight-manager`。更新该 profile 中同名包的安装来源，不要同时挂载
两个管理器实例。若 profile 还启用了上游 `@vectorize-io/hindsight-coding-agents` bundle，
在 profile 的 `cordis.patch.yml` 中停用其原始插件行，以免重复注册记忆工具：

```yaml
- id: hindsight
  disabled: true
```

新安装仅启用本包即可，不需要安装上游 bundle。卸载使用：

```bash
dsh plugin --profile web remove dsh-hindsight-manager
```

## 配置

沿用 Hindsight 的配置文件 `~/.hindsight/coding-agent.json`。下面是自建服务的示例；
把地址、目录和 bank 改成实际值。`apiUrl` 是 REST 根地址，不带 `/mcp` 后缀。

```json
{
  "serverMode": "self-hosted",
  "apiUrl": "http://127.0.0.1:8888",
  "autoUpdate": false,
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

面板保存后，后续工具调用和会话步骤使用新的 bank、服务地址与工作区映射；已有会话也会
生效。首次添加或删除映射会同步更新工具清单。已开始的请求使用开始时的配置完成。
在面板外直接编辑配置文件后，需要重新加载插件。

## 行为与兼容性

- 工具通过 `tools.register(definition, { when })` 按当前 Agent 的工作区决定可见性。
- `agent/created` 初始化会话，`agent/pre-step` 注入记忆并保留 `startsRequestSeries`。
- `agent/turn-stopping` 执行会话回写；子 Agent 不启用记忆工具或自动注入。
- 工具和召回请求响应宿主取消信号，HTTP 重试及等待同样可取消。
- 卸载清理工具、事件与路由，释放 runtime，并等待已启动的写回收尾。

当前版本仍使用宿主允许旧逻辑暂时保留的 `snapshotEvents()` 接口。已有后台 seed 不因配置
刷新被强制取消。`engines.dsh` 只声明已验证的宿主版本，更新宿主后应重新验证兼容性。

## 开发与验证

安装对应版本的 DSH 并让 `dsh` 位于 `PATH`，然后执行：

```bash
npm run check
npm test
```

回归测试覆盖工作区过滤、同目录配置刷新、首次添加和删除映射、请求序列边界、并发取消隔离、
重试取消以及真实 Cordis 插件的加载／卸载／重载。HTTP 使用替身，配置和日志使用临时目录。

运行文件直接提交到仓库，Git 安装和 tarball 安装不需要 `prepare` 或其他构建脚本。
上游运行时代码的来源与本地变更见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

官方规范：[插件开发](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) ·
[打包安装](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish) ·
[工具接口](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools)

## 许可证

MIT；上游及打包依赖的声明保留在 vendor 中。
