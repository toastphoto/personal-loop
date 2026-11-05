# DSH 原生项目只读桥

本包使用 DeepSeek Harness 官方 profile bundle 格式，目标版本为 **0.2.1-rc.3**。它在既有 Desktop Host 内借用 `workspaceRegistry`、`sessionQuery`、`agents` 公开服务，向同一系统用户提供原生 Workspace / Session 元数据。

它不启动第二个Host，不重新打开共享存储，不读取Desktop IPC、认证Cookie或凭据文件，不调用模型、不注册模型工具，不修改项目、会话、消息、队列或权限。安装插件本身是Host代码变更，必须先审查并安排合适的重启窗口。

## 运行与读取边界

`cordis.patch.yml` 只插入 `personal-loop-native-metadata` 一个条目。默认socketPath为当前用户 `~/.local/run/personal-loop-dsh/native.sock`，实际配置必须是绝对路径。

- 父目录归当前用户所有、严格0700；socket为0600，没有TCP监听
- 没有任意文件、shell、HTTP或Remote endpoint代理；已有socket路径拒绝覆盖
- 默认请求最大16KiB、响应2MiB、读取3秒、最多8客户端及每客户端4个并发读取
- 只使用现有服务的 `workspaceRegistry.list()`、`sessionQuery.listSessions(signal)`、`agents.get(id)`，不读会话正文
- 轻量API不能可靠提供会话标题和最后活动时间时返回null，不扫描日志补齐
- running来自当前Host；未加载会话返回null和not_loaded，不能据此宣称全机空闲
- 元数据仍是私人数据，不提交公开仓库或原样发群

此桥只有读取能力，不支持续办、停止或改变状态。目录连接成功不是原生写操作验收。

## 固定协议

Unix socket上每行一条JSON请求/响应：

```json
{"id":"request-1","method":"workspace/list","params":{}}
```

| 方法 | 参数 | 返回 |
|---|---|---|
| workspace/list | `{}` | items：workspaceId/title/path/sessionIds |
| session/list | `{}` 或 `{workspaceId}` | items：元数据及原生projectId |
| session/read | `{sessionId}` | 单会话元数据 |
| session/status | `{sessionId}` | 单会话元数据及当前Host状态 |

其他方法或多余参数全部拒绝。成功为 `{id,ok:true,result}`，结果包含observedAt、complete、bridgeInstance、hostProcessId；失败为 `{id,ok:false,error:{code}}`，不转发内部异常文本。

没有持续订阅或模型后台任务；客户端断开取消其读取，dispose关闭所有客户端并仅清理自己创建的socket。只用Workspace的原生Session成员关系，不根据相同cwd猜归属；缺失成员头部时complete=false。

## 安装前验证

在本目录运行：

```sh
node --test bridge.test.mjs
npm pack --dry-run --ignore-scripts --json
```

安装前将 `/path/to/repository` 替换为本插件所在仓库的实际绝对路径。发布文件仅应有package.json、index.mjs、cordis.patch.yml、README.md，不包含测试、runtime、项目数据或凭据。没有安装生命周期脚本，没有新增运行时依赖。Cordis peer为可选宿主兼容声明，实际服务由Host注入。

## 合法安装入口

官方Desktop支持主应用“插件”页的正常插件管理，也支持 **完全退出Desktop后** 用Desktop安装的CLI管理desktop profile。安装前用 `command -v dsh` 核对命令确实来自Desktop安装。以下命令使用常见的 `$HOME/.local/bin/dsh` 位置，实际路径以应用“管理 dsh 命令”中显示的位置为准。

先在App核实无执行中、等待审批或排队任务，再用 `⌘Q` 或应用菜单“退出 DeepSeek Harness”。关闭窗口仅隐藏，Host仍运行。若退出提示会中断任务，应取消退出并等待任务正常结束，不强杀或自动确认。

以下为拟安装命令，代码准备阶段没有执行：

```sh
"$HOME/.local/bin/dsh" plugin --profile desktop add \
  'file:/path/to/repository/integrations/dsh-native-bridge' --ignore-scripts
```

官方安装器维护desktop profile的依赖、包锁、node_modules和bundle选择，保留profile写锁和版本检查。它不把此bundle装到web/headless/sdk，本包不修改其他profile或home级patch。不要添加版本豁免。若CLI不是Desktop安装版、profile未初始化、锁未释放或版本不兼容，应按明确错误处理。

然后通过Finder、Dock或正常命令重开：

```sh
open -a '/Applications/DeepSeek Harness.app'
```

Desktop默认无HMR，按需要重启处理；安装成功不等于已激活。验收应核socket权限、四个只读方法、项目计数与App一致、Host PID对应，确认没有模型启动和私人正文输出。

## 移除与恢复

任务结束并正常退出Desktop后：

```sh
"$HOME/.local/bin/dsh" plugin --profile desktop remove '@personal-loop/dsh-native-bridge'
```

重开后核插件不再激活。正常dispose移除自己拥有的socket，保留0700父目录，不删除项目、会话和历史。异常退出留下socket时，先确认原App已退出、该socket无监听，再由维护者清理，不能盲删。回滚profile应使用安装前的精确备份并保留同期其他变更。

## 机制来源与验收范围

- [Desktop内置命令与profile归属](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.zh.md#bundled-command-runtime)
- [插件管理器与本地file包](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.zh.md)
- [CLI配置层](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.zh.md)
- [Workspace公开服务](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workspace/workspace/README.zh.md)

本插件按0.2.1-rc.3安装包的bundle声明、CLI `manageDesktopProfile: true` 和服务接口实现。GitHub master会变化；真实安装和App项目读取仍需独立验收。本轮测试是实际UDS加受控假Host服务，不是用户Desktop端到端通过。
