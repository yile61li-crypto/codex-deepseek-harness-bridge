# DeepSeek Harness Bridge for Codex

A local MCP bridge that lets Codex delegate work to an already running
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web runtime. Both clients use
the same DSH process and session store, so delegated sessions and live tool activity remain visible
in the DSH Web UI.

[中文说明](README.zh-CN.md)

## Requirements

- Node.js 22.19 or newer.
- DeepSeek Harness Web running on `http://127.0.0.1:3080`.
- A DSH version compatible with the developer-preview `session.*` Web RPC and event streams. The
  bridge is currently tested against DSH `0.1.0-rc.5`.

## Install in Codex

Install this repository as a Codex plugin or add it to a compatible Agent Plugins marketplace.
The included `.mcp.json` starts the dependency-free MCP server with Node and connects only to the
loopback DSH URL.

After installation, start a new Codex task so the MCP tool catalog is refreshed.

## Tools

| Tool | Purpose |
|---|---|
| `dsh_health` | Check the local DSH Web runtime. |
| `dsh_list_sessions` | List sessions visible in DSH Web. |
| `dsh_start_task` | Create a visible session and submit a model task. |
| `dsh_send` | Queue or steer another message. |
| `dsh_wait` | Wait for completion or a user-action boundary. |
| `dsh_history` | Read compact message-level history. |
| `dsh_cancel` | Cancel the active turn without deleting queued work. |

`dsh_start_task` and `dsh_send` invoke the model configured in DSH and may incur usage. The bridge
does not auto-approve tool permissions or answer DSH questions; use the Web UI for those actions.

## Configuration

The plugin sets `DSH_WEB_URL=http://127.0.0.1:3080`. A different loopback port can be configured by
overriding that environment variable. Remote hosts, HTTPS URLs, credentials, paths, queries, and
fragments are rejected deliberately.

## Development

```sh
npm run check
npm test
npm run test:live
```

`test:live` is read-only: it lists sessions from the running DSH Web runtime and does not submit a
prompt.

## Compatibility note

DeepSeek Harness currently labels this surface as developer preview. This project uses its browser
RPC (`/api/session.*`) and WebSocket event streams rather than the Python SDK because the SDK starts
a separate runtime whose sessions are not automatically visible in the existing Web UI.

## License

MIT
