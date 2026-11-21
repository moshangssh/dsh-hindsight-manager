# 最新官方运行时的 DSH 增强

当前交付对应 `@vectorize-io/hindsight-coding-agents` **0.8.8**，宿主为 DSH **0.2.2-rc.1**。
官方包继续执行记忆检索与保存；管理器通过公开的只读服务和观测事件显示实际运行状态。

`0.8.8/source.patch` 是针对上游发布源码的维护补丁，`0.8.8/delivery.patch` 是通过构建生成、
针对同版本 npm 发布包的离线补丁。根目录旧四份补丁仅属于 0.8.7，不能与当前补丁混用。

## 包含的行为

- DSH 生命周期、工作区实例隔离、请求取消、工具注册和会话回写修复。
- 按用户消息执行主动召回；工具续步不重复，同一结果在下一次实际检索后仍可重新注入。
- 回复结束后提交会话，由服务端异步提取记忆；注入内容排除在回写之外。
- 只读运行时状态：当前工作区、最终 bank、服务地址、实际配置、加载版本。
- 逐次召回摘要：模式、各阶段结果、耗时、失败或降级；以宿主提交消息确认记忆正文进入上下文。

运行状态查询不创建工作区、不激活历史会话。摘要不增加 Hindsight 请求，不记录查询与记忆正文，
不进入模型上下文。实际注入不等于模型采纳。检索完成后准备阶段中断不会覆盖检索结果。

## 离线部署

先准备官方 **0.8.8** 的完整发布包、Node.js、DSH 和可访问的内网 Hindsight 服务。
在新目录展开官方包，并应用配套发布补丁：

```bash
manager_repo=/absolute/path/to/dsh-hindsight-manager
hindsight_package=/absolute/path/to/hindsight-coding-agents

git -C "$hindsight_package" apply "$manager_repo/runtime-patches/0.8.8/delivery.patch"
npm --prefix "$hindsight_package" run test:dsh
npm --prefix "$manager_repo" run test:runtime -- "$hindsight_package"
```

上述验证使用模拟 HTTP，不向真实服务写入数据。部署不需要 TypeScript 开发依赖。
将管理器 `manager.config.json` 中 `officialPackagePath` 设置为 DSH 实际加载的增强包目录，
安装该本地包并重启 DSH、刷新 Web 页面。只更新管理器不会改变官方运行时。
已有 0.8.7 增强应更换到准备好的新包目录，保留原有官方用户配置文件；不要在旧目录追加此补丁。

`dsh-enhancement.json` 表示安装产物声明；聊天标题状态窗口通过当前运行实例确认实际加载版本。
配置按工作区首次使用时缓存。保存配置后需重启 DSH，不能用新会话或磁盘声明推断配置已经生效。

## 根目录参数

官方增强包的 `dsh-memory.config.json` 提供默认值：

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

频率 1 表示每次用户消息检索；N 在第 1、1+N、1+2N 次清除缓存；0 保留首次检索及可能重试。
空结果与失败仍按已有规则重试，因此非到期轮也可能检索。关闭正文检索使用 `autoInject: "none"`。
工具、页面目录和自动回写各自遵循配置。用户配置顶层、DSH、paths、banks 继续覆盖上述默认值。
`recallOptions` 在层之间整组替换。新参数不通过环境变量注入。

## 源码维护与上游更新

每次开发及交付前查询最新版本和其源码提交；本次 0.8.8 对应上游发布提交
`0a7ed29d705d967fe1f759c542842fa3709c3d43`。部署机器继续离线，版本跟进在开发端完成。

1. 查询 npm latest、gitHead，并检查 main 中尚未发布的相关差异。
2. 在该发布源码上移植 `source.patch`，删除上游已经吸收的改动，保留尚未吸收的 DSH 能力。
3. 在 `hindsight-integrations/coding-agents` 使用本包锁文件准备开发依赖，运行源码测试、类型检查和构建。
4. 将构建生成的 DSH bundle、根参数、声明及离线测试与同版本完整发布包比较，生成 `delivery.patch`。
5. 在干净发布包上应用新补丁，运行运行时测试与管理器组合测试，更新管理器支持版本和文档。

```bash
git -C /absolute/path/to/hindsight-source apply /absolute/path/to/manager/runtime-patches/0.8.8/source.patch
cd /absolute/path/to/hindsight-source/hindsight-integrations/coding-agents
npm ci
npm test
./node_modules/.bin/tsc --noEmit
npm run build
```

源码补丁是维护依据，不手工修改生成 bundle 来替代源码修改。构建可能输出其他助手的 bundle，
离线增强只替换 DSH bundle，保留官方其他入口。管理器不会后台下载、更新或重打补丁。
重新安装官方插件会覆盖本地增强，升级后需要重新准备匹配版本的安装产物。
