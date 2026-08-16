# Codex DeepSeek Harness Bridge

这是一个本地 MCP 桥，让 Codex 启动或复用
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 进程，并用 Codex 内置浏览器在右侧打开它。Codex 和网页使用同一个
DSH 进程与会话存储，因此新会话、思考过程、工具调用和最终结果都能继续在 DSH Web UI 中看到。

## 环境要求

- Node.js 22.19 或更高版本。
- 可使用插件锁定的 `@deepseek-ai/dsh` 依赖；若目标地址已有 DSH，插件会直接复用。
- DSH Web 的 `session.*` RPC 与事件流和本插件兼容。目前针对 DSH `0.1.0-rc.5` 和 `0.1.0-rc.6` 验证。

## Codex 安装

将本仓库作为 Codex 插件安装，或者把它加入兼容的 Agent Plugins marketplace。仓库内的
`.mcp.json` 会用 Node 启动 MCP Server，并且只允许连接本机回环地址。安装依赖后，用户只需说“打开
DeepSeek Harness”：插件先执行 `dsh_ensure_runtime`，健康后再调用 Codex 自带的 Browser 在右侧打开页面。

从源码安装时先在插件目录执行一次：

```sh
npm ci --ignore-scripts
```

这会按 `package-lock.json` 安装锁定的官方 DSH 运行时；如果只连接用户已启动的 DSH，则 MCP 读取工具
本身没有第三方运行时依赖。

安装后新建一个 Codex 任务，让 Codex 重新加载 MCP 工具目录。

## 工具

| 工具 | 用途 |
|---|---|
| `dsh_runtime_status` | 检查本机 DSH 是否已运行及启动配置。 |
| `dsh_ensure_runtime` | 复用健康运行时；不存在时安全启动本地 DSH。 |
| `dsh_health` | 检查 DSH、桥安全策略与可选能力。 |
| `dsh_list_workspaces` | 列出已注册工作区及其会话。 |
| `dsh_list_agent_presets` | 列出可用和损坏的 Agent Preset。 |
| `dsh_list_sessions` | 列出并筛选最近会话。 |
| `dsh_get_session` | 读取精确会话及可选的有界历史。 |
| `dsh_search_sessions` | 在 DSH 开启查询索引时搜索会话内容。 |
| `dsh_get_models` | 查看当前模型和可路由模型目录。 |
| `dsh_start_task` | 始终新建网页可见会话并提交任务。 |
| `dsh_rename_session` | 只修改会话标题。 |
| `dsh_fork_session` | 在已完成轮次边界分叉，不调用模型。 |
| `dsh_set_permission` | 修改单个会话的 DSH 权限预设。 |
| `dsh_send` | 按精确会话 ID 排队续写或在运行中 steer。 |
| `dsh_wait` | 等待完成，或返回结构化审批详情。 |
| `dsh_answer_approval` | 显式启用后，对精确审批请求仅本次批准或拒绝。 |
| `dsh_answer_question` | 显式启用后，回答或取消一整批精确问题。 |
| `dsh_history` | 读取可分页、有上限的消息和可选工具活动。 |
| `dsh_cancel` | 取消当前轮次，不删除排队任务。 |

`dsh_start_task` 和 `dsh_send` 会调用 DSH 已配置的模型，可能产生额度消耗。插件永远不会自动审批或回答。

## 新建还是继续同一个对话

插件不会保存进程级“最后一个会话”，因为多个 Codex 任务并行时可能静默写错 DSH 对话。

- 继续已有工作：保留 `dsh_start_task` 或 `dsh_fork_session` 返回的 `sessionId`，后续始终传给
  `dsh_send`。它还会返回 `waitAfterSeq` 和 `promptRpcId`；分别传给 `dsh_wait.after_seq` 和
  `dsh_wait.prompt_rpc_id`，就不会把上一轮旧答案或排队在前面的轮次误报成当前结果。
- 新建工作：指定已注册的 `workspace_id` 或绝对 `cwd`。如果工具参数和安装默认值都没有，
  `dsh_start_task` 返回 `task-target-required`，Codex 应先列出工作区/会话，再询问用户。
- 可写权限必须使用已注册的 `workspace_id`；任意 `cwd` 只允许 `read-only`，防止模型通过选择父目录扩大写沙箱。

因此 `dsh_start_task` 永远表示“新对话”，`dsh_send` 永远表示“继续这个精确对话”。

## 配置与安全边界

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `DSH_WEB_URL` | `http://127.0.0.1:3080` | 已运行的 DSH Web；只接受本机回环 HTTP。 |
| `DSH_RUNTIME_COMMAND` | 未设置 | 可选的 DSH 可执行文件；未设置时使用本包锁定的官方 `@deepseek-ai/dsh`。 |
| `DSH_RUNTIME_ARGS_JSON` | 未设置 | 传给自定义可执行文件、位于固定 `web --host/--port` 参数之前的 JSON 字符串数组。 |
| `DSH_RUNTIME_CWD` | 专用状态目录 | 自定义运行时工作目录；默认不使用插件源码目录，也不影响任务自身选择的工作区。 |
| `DSH_RUNTIME_LOG_DIR` | 用户状态目录 | DSH stdout/stderr 日志目录；不会写入 MCP stdout。 |
| `DSH_RUNTIME_START_TIMEOUT_MS` | `30000` | 等待 DSH 健康的毫秒数，范围 1000–120000。 |
| `DSH_DEFAULT_PERMISSION` | `read-only` | 每个新任务的默认权限。 |
| `DSH_MAX_PERMISSION` | `workspace-write` | 工具参数无法越过的权限硬上限；设为 `read-only` 即锁死只读。 |
| `DSH_DEFAULT_WORKSPACE_ID` | 未设置 | 新任务没指定目标时使用的已注册工作区。 |
| `DSH_DEFAULT_CWD` | 未设置 | 只读任务的默认目录；不能与默认工作区同时设置。 |
| `DSH_ENABLE_APPROVAL_RESPONSES` | `false` | 是否允许通过 MCP 回复审批；关闭时只能在 DSH 网页处理。 |
| `DSH_ENABLE_QUESTION_RESPONSES` | `false` | 是否允许通过 MCP 回答或取消精确问题批次。 |
| `DSH_MAX_CONCURRENT_WAITS` | `4` | 限制长连接等待数量。 |
| `DSH_MODEL_REQUESTS_PER_MINUTE` | `12` | 限制可能消耗额度的新建/续写调用。 |

普通用户有两种调整方式：

1. 单次任务：在 `dsh_start_task` 里指定 `permission`，或用 `dsh_set_permission` 修改某个现有会话。
2. 安装级默认值：编辑插件根目录 `.mcp.json` 的 `env`，修改上表变量后重启 Codex，并新建任务以重新加载 MCP Server。

默认权限不能高于最大权限。完全访问必须同时把 `DSH_MAX_PERMISSION` 设为 `danger-full-access`，并在该次
工具调用中再次明确选择 `danger-full-access`；只提高上限不会自动提升任何会话。

每次 `dsh_start_task` 都可以用 `permission` 覆盖默认值。插件先创建会话，再调用 DSH 宿主侧
`/permission <preset>` 命令，成功后才提交模型任务：

- `read-only`：禁止文件修改；但 DSH 的文件策略并不限制读取、网络访问和进程可见性。
- `workspace-write`：DSH Web 默认值；文件修改限制在会话工作区及受支持的临时目录。该文件策略不限制
  读取、网络访问和进程可见性。
- `danger-full-access`：不受 DSH 文件沙箱限制；插件默认禁止，必须由操作者显式开启。

`dsh_wait` 遇到审批或问题时会返回精确请求身份、内容、观察时间和 `mayBeStale=true`。安全默认下由用户在
DSH 网页处理。可选 MCP 回复只接受精确的待处理身份；如果已被网页或其他客户端处理，则幂等返回
`already_resolved`。审批只支持 `allow_once` 或 `reject`，不提供永久授权或自动回答。

`dsh_history` 返回 `firstSeq` 和 `nextBeforeSeq`，下一页应把后者作为排他的 `before_seq`。工具参数和输出
默认不返回；只有明确设置 `include_tools=true` 才返回，并始终截断，以控制敏感信息和 token 消耗。

可以用 `DSH_WEB_URL` 更换本机端口，但插件会拒绝局域网和公网地址、HTTPS、URL 凭据、路径、查询参数
及 fragment，因为当前 DSH Web API 依赖本机信任边界，并不是带用户认证的远程 API。

`dsh_ensure_runtime` 是幂等的：目标端口已有健康 DSH 时不创建新进程，也从不终止外部进程。新进程通过
Node 直接执行官方 `lib/bin.js`，固定 `shell=false`、回环地址和配置端口；日志与 MCP JSON-RPC 标准输出
隔离。MCP 不能直接控制 Codex 窗口，所以插件技能在健康检查后调用 Codex 宿主的内置 Browser，这不是
`.app.json` WebView，也不会跳到系统浏览器。

## 开发与验证

```sh
npm run check
npm test
npm run test:live
npm run test:mcp-live
```

两个 live probe 都不发送提示词：`test:live` 只读验证 DSH 客户端；`test:mcp-live` 先幂等确保运行时，
再验证完整的 Codex stdio MCP 链路，因此目标端口为空时可能启动本地 DSH。

## 兼容性说明

DeepSeek Harness 当前仍处于 developer preview。本插件直接使用网页内部的 `/api/session.*` RPC 和
WebSocket 事件流，而不使用 Python SDK，因为 Python SDK 会启动独立 DSH Runtime，默认不会与当前
Web UI 共用会话。

`host.describe.version` 目前是 DSH 内部占位值 `0.0.1`，不是产品版本；插件将其报告为
`reportedHostApiVersion`，并分别探测可选接口。某些部署没有开启会话查询索引，此时搜索会明确返回
`search-disabled`。DSH 也没有 `session.get` 或 `session.delete` RPC；本插件使用受支持的列表/历史接口组合
详情，不会伪造“删除会话”能力。

插件也不会为了堆工具数量而暴露高权限管理面：切换模型可能同时修改 DSH 保存的默认模型，删除工作区实际
只会注销元数据，而任意本地路径图片上传会让桥进程绕过 DSH 权限沙箱读取文件。这些能力必须先有独立的
安全设计，才会成为公开 MCP 工具。

## 许可证

MIT
