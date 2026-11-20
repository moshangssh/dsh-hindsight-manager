# dsh-hindsight-manager

为官方 `@vectorize-io/hindsight-coding-agents` 提供设置和增强入口。
官方插件执行记忆检索、上下文注入和会话回写；管理器配置连接、工作区映射、
自动召回方式、频率与预算，并保留官方配置的继承关系。

管理器通过读写官方配置文件协作，不导入或自动修改官方运行时，不注册记忆工具或订阅
Agent 会话事件。两个插件安装在同一个 DSH profile 中，分别通过插件市场或插件管理命令更新。
本地增强以明确的官方版本为基线，升级时单独验证兼容性。

仓库另附[每轮主动召回的运行时补丁](runtime-patches/README.md)，将每个用户回合的自动检索、
上下文注入和回复后的自动保存连成长期记忆闭环。补丁针对官方插件 `0.8.7`，包含配置文件和
回归测试，可离线应用。**只更新管理器不会自动启用这项能力**，请按补丁说明应用、
关联安装目录并重启 DSH。

目标宿主为 **DSH 0.2.2-rc.1**，包要求 **Node.js ≥ 24.9.0**。
本次接口契约核对采用部署服务的 **Hindsight API 1.2.3**：库列表使用
`banks / total / limit / offset`，库标识为 `bank_id`。运行时增强以官方 **0.8.7** 为基线。

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
dsh plugin --profile web add ./dsh-hindsight-manager-0.3.0.tgz --offline
```

这个安装包包含管理界面及可手动应用的运行时补丁。Node.js、DSH、官方 Hindsight 插件和可访问的 Hindsight 服务
需要预先准备；官方插件按 DSH 提供的离线包或缓存安装方式部署。

## 设置与继承

面板读写 `~/.hindsight/coding-agent.json`。读取时由 `harnesses.dsh` 覆盖顶层同名字段，
保存时只提交实际修改项；没有修改的继承值不会被固定到 `harnesses.dsh`。
其他助手、`paths`、`banks`、Token 和未展示的字段保留。

| 区域 | 设置 |
| --- | --- |
| 连接与工作区 | 服务地址、工作区到 bank 的映射、启用范围 |
| 常用设置 | 自动召回方式、用户回合频率、独立的自动会话回写 |
| 高级参数 | recall 检索预算、返回 token 预算、记忆类型、自动检索超时 |

每项显示配置来源；“恢复继承”在保存后删除相应 DSH 覆盖。
恢复连接会一起删除 DSH 的 `apiUrl / serverMode / apiPort`，保留 Token。
恢复召回方式会同时删除 `autoInject` 和旧别名 `autoReflect`。
清空工作区映射是显式的空映射；恢复映射继承才会重新采用顶层映射。
未填写完整或规范化后重复的映射会报告具体行，整次保存不写文件。

`recallOptions` 在官方配置层之间是**整组替换**。修改其中一个可见子项时，管理器保留当前
获胜原始对象中的 `tags`、`include` 等其他字段，再写入 DSH 层；“恢复召回选项继承”删除整个
DSH `recallOptions`。例如顶层是 `{"types":["world"],"budget":"high"}`，DSH 是
`{"max_tokens":1000}`，实际类型和预算来自客户端默认的 observation / low，而不是顶层。

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
连接测试使用第一个已保存的工作区映射。库列表展示服务返回的一页，并说明已显示数量与总数。
这两个操作使用已保存的 DSH 默认连接，不应用具体工作区的 `paths`、`banks` 覆盖。
页面中的目录状态表示目录是否存在；记忆库的最终解析由官方插件负责。

## 自动召回与回写

`autoInject` 的四种方式是：关闭（none）、检索事实（recall）、查找页面（pages）、推理合成（reflect）。
关闭只停止自动检索记忆正文；记忆工具、独立的会话回写和页面目录/工具说明继续按官方配置运行。

安装逐轮增强后，频率 `0` 保留原先首次召回及可能重试的逻辑；`1` 每个用户回合召回，
正整数 N 在第 1、1+N、1+2N 个用户回合重新召回。同轮工具后续步骤不会重复触发。
当前实现同步检索当前用户消息，并不使用 Hermes 的下一轮后台预取。

检索预算、返回 token 预算和类型作用于 recall 请求，包括 reflect 可降级失败后的 recall。
`injectTimeoutMs` 控制 recall/pages 检索，并为 reflect 降级时先 pages 后 recall 的两步提供共享预算；
它不是 reflect 主体或整轮回答的超时。token 预算不包含目录、工具说明和累计历史。
高级参数一直可访问；切换方式会保留其他方式的设置。

记忆类型使用字符串数组，`null` 表示所有类型；可以保留已有自定义类型和空数组。
当前增强默认包含 observation、world、experience；未覆盖时官方客户端默认只有 observation。
配置读取先合并原始字段，再解析默认值和旧别名，因此无显式 `autoInject` 时，`autoReflect:false`
仍可关闭自动召回；增强参数文件显式设置的 `autoInject:recall` 则优先于旧别名。

关闭自动会话回写（`retainSessions:false`）后仍能检索已有记忆，也不禁止手动记忆工具写入。
服务端异步提取完成后，新写入内容才可被检索。每轮召回和更大的返回预算不代表结果一定更好；
本次功能验证不构成记忆效果对照实验。

## 关联增强与配置生效

管理器自身参数集中在根目录 `manager.config.json`。在该文件设置 `officialPackagePath`，
填写 DSH 实际加载的、已经应用四份补丁的官方插件目录。
管理器读取该目录的 `package.json`、`dsh-enhancement.json` 和 `dsh-memory.config.json`。
声明与受支持基线一致时，频率控件开放编辑；未关联或未声明时保持只读，其他官方设置仍可用。
关联文件错误会显示具体问题。关联声明只描述安装产物，不证明当前 DSH 进程已经加载它。

增强参数文件提供一层默认值，用户配置顶层和 `harnesses.dsh` 的显式字段继续覆盖它。
管理器参数包括配置文件位置、安装目录、请求超时、库列表页面大小及表单所需默认值；
新增参数均通过文件配置，不增加环境变量入口。页面读取本身不会写入配置。

**保存后请重启 DSH，让官方插件读取新配置。** 管理器不会调用官方内部 API 刷新运行时。
重新读取按钮、测试连接、刷新库列表均使用磁盘上已经保存的配置。

设置影响读取同一文件的 DSH 实例，不只影响打开面板的 profile。文件配置视图不包含官方既有
环境变量兼容层，也不代表运行中状态。若配置路径自定义，确保管理器的 `configPath` 与官方插件一致。

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

常规测试覆盖当前面板、增量保存、继承恢复、服务响应、Cordis 生命周期及独立安装包加载，
无需官方记忆运行时。组合验收另行执行，必须提供应用四份补丁的本地官方包：

```bash
npm run test:runtime -- /absolute/path/to/prepared/hindsight-coding-agents
```

组合测试经管理器保存临时配置后重建运行时，检查实际召回参数、频率、取消、工作区 bank、
独立回写与模式切换。两类测试均使用模拟 HTTP，不向真实 Hindsight 写入内容。
缺少运行时参数会明确失败，不以跳过测试代替通过。
详细补丁顺序和离线验证见 [runtime-patches/README.md](runtime-patches/README.md)。

## 许可证

MIT。
