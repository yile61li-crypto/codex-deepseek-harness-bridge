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
| `dsh_send` | 排队发送消息或在运行中 steer。 |
| `dsh_wait` | 等待完成或等待用户处理权限/提问。 |
| `dsh_history` | 读取压缩后的消息级历史，不返回海量 token chunk。 |
| `dsh_cancel` | 取消当前轮次，不删除排队任务。 |

`dsh_start_task` 和 `dsh_send` 会调用 DSH 已配置的模型，可能产生额度消耗。插件不会自动批准权限，
也不会代替用户回答 DSH 的提问；这些动作在网页里处理。

## 配置与安全边界

默认使用 `DSH_WEB_URL=http://127.0.0.1:3080`。可以通过环境变量更换本机端口，但插件会拒绝局域网
和公网地址、HTTPS、URL 凭据、路径、查询参数及 fragment。这是因为当前 DSH Web API 使用本机信任
边界，并不是带用户认证的远程 API。

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
