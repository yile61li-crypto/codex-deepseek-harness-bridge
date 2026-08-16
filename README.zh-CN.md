# Codex DeepSeek Harness Bridge

这是一个本地 MCP 桥，让 Codex 把任务交给已经运行的
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 进程。Codex 和网页使用同一个
DSH 进程与会话存储，因此新会话、思考过程、工具调用和最终结果都能继续在 DSH Web UI 中看到。

## 环境要求

- Node.js 22.19 或更高版本。
- DeepSeek Harness Web 正在 `http://127.0.0.1:3080` 运行。
- DSH Web 的 `session.*` RPC 与事件流和本插件兼容。目前针对 DSH `0.1.0-rc.5` 验证。

## Codex 安装

将本仓库作为 Codex 插件安装，或者把它加入兼容的 Agent Plugins marketplace。仓库内的
`.mcp.json` 会用 Node 启动无运行时依赖的 MCP Server，并且只允许连接本机回环地址。

安装后新建一个 Codex 任务，让 Codex 重新加载 MCP 工具目录。

## 工具

| 工具 | 用途 |
|---|---|
| `dsh_health` | 检查本机 DSH Web 是否可用。 |
| `dsh_list_sessions` | 列出 DSH 网页可见会话。 |
| `dsh_start_task` | 创建网页可见会话并提交任务。 |
| `dsh_set_permission` | 修改单个会话的 DSH 权限预设。 |
| `dsh_send` | 排队发送消息或在运行中 steer。 |
| `dsh_wait` | 等待完成，或返回结构化审批详情。 |
| `dsh_answer_approval` | 显式启用后，对精确审批请求仅本次批准或拒绝。 |
| `dsh_history` | 读取压缩后的消息级历史，不返回海量 token chunk。 |
| `dsh_cancel` | 取消当前轮次，不删除排队任务。 |

`dsh_start_task` 和 `dsh_send` 会调用 DSH 已配置的模型，可能产生额度消耗。插件永远不会自动批准权限；
DSH 的普通提问仍只在网页处理。

## 配置与安全边界

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `DSH_WEB_URL` | `http://127.0.0.1:3080` | 已运行的 DSH Web；只接受本机回环 HTTP。 |
| `DSH_DEFAULT_PERMISSION` | `workspace-write` | 每个新任务提交前设置的权限：`read-only`、`workspace-write` 或 `danger-full-access`。 |
| `DSH_ALLOW_DANGER_FULL_ACCESS` | `false` | 只有操作者显式打开后，MCP 工具才能选择完全访问。 |
| `DSH_ENABLE_APPROVAL_RESPONSES` | `false` | 是否允许通过 MCP 回复审批；关闭时只能在 DSH 网页处理。 |

普通用户有两种调整方式：

1. 单次任务：在 `dsh_start_task` 里指定 `permission`，或用 `dsh_set_permission` 修改某个现有会话。
2. 安装级默认值：编辑插件根目录 `.mcp.json` 的 `env`，修改上表变量后重启 Codex，并新建任务以重新加载 MCP Server。

例如，希望默认只读时，把 `DSH_DEFAULT_PERMISSION` 改为 `read-only`。希望允许某次任务使用完全访问时，必须
同时把 `DSH_ALLOW_DANGER_FULL_ACCESS` 改为 `true`，并在该次工具调用中明确选择
`danger-full-access`；仅开启开关不会自动把任何会话提升为完全访问。

每次 `dsh_start_task` 都可以用 `permission` 覆盖默认值。插件先创建会话，再调用 DSH 宿主侧
`/permission <preset>` 命令，成功后才提交模型任务：

- `read-only`：禁止文件修改，需要更宽操作时由用户单次批准。
- `workspace-write`：DSH Web 默认值；文件修改限制在会话工作区及受支持的临时目录。该文件策略不限制
  读取、网络访问和进程可见性。
- `danger-full-access`：不受 DSH 文件沙箱限制；插件默认禁止，必须由操作者显式开启。

`dsh_wait` 遇到审批时会返回精确的 `rpcId`、`approvalId`、工具名、调用 ID、理由以及 MCP 回复是否启用。
安全默认下，用户在 DSH 网页批准或拒绝。设置 `DSH_ENABLE_APPROVAL_RESPONSES=true` 后，Codex 可以调用
`dsh_answer_approval` 选择 `allow_once` 或 `reject`，但仍必须先获得用户对该次请求的明确决定。插件不提供
永久自动批准。

可以用 `DSH_WEB_URL` 更换本机端口，但插件会拒绝局域网和公网地址、HTTPS、URL 凭据、路径、查询参数
及 fragment，因为当前 DSH Web API 依赖本机信任边界，并不是带用户认证的远程 API。

## 开发与验证

```sh
npm run check
npm test
npm run test:live
```

`test:live` 只读取当前 DSH 会话，不发送提示词，也不会产生模型调用。

## 兼容性说明

DeepSeek Harness 当前仍处于 developer preview。本插件直接使用网页内部的 `/api/session.*` RPC 和
WebSocket 事件流，而不使用 Python SDK，因为 Python SDK 会启动独立 DSH Runtime，默认不会与当前
Web UI 共用会话。

## 许可证

MIT
