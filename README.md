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
| `dsh_set_permission` | Change one session's DSH permission preset. |
| `dsh_send` | Queue or steer another message. |
| `dsh_wait` | Wait for completion or return structured approval details. |
| `dsh_answer_approval` | Allow once or reject an exact pending approval when explicitly enabled. |
| `dsh_history` | Read compact message-level history. |
| `dsh_cancel` | Cancel the active turn without deleting queued work. |

`dsh_start_task` and `dsh_send` invoke the model configured in DSH and may incur usage. The bridge
never auto-approves tool permissions. DSH questions remain Web-UI-only.

## Configuration

| Environment variable | Default | Meaning |
|---|---|---|
| `DSH_WEB_URL` | `http://127.0.0.1:3080` | Existing DSH Web runtime. Only loopback HTTP URLs are accepted. |
| `DSH_DEFAULT_PERMISSION` | `workspace-write` | Permission applied before every new task: `read-only`, `workspace-write`, or `danger-full-access`. |
| `DSH_ALLOW_DANGER_FULL_ACCESS` | `false` | Operator opt-in required before any MCP tool may select `danger-full-access`. |
| `DSH_ENABLE_APPROVAL_RESPONSES` | `false` | Expose working approval responses through MCP instead of Web-UI-only handling. |

Users can configure permissions at two levels:

1. Per task: pass `permission` to `dsh_start_task`, or use `dsh_set_permission` for an existing session.
2. Installation default: edit the plugin root `.mcp.json` `env` values, restart Codex, and start a new task so the MCP server reloads.

For a read-only default, set `DSH_DEFAULT_PERMISSION=read-only`. Full access requires both
`DSH_ALLOW_DANGER_FULL_ACCESS=true` and an explicit `danger-full-access` selection for that tool
call; enabling the gate alone never upgrades a session.

Every `dsh_start_task` may override `permission`; the bridge creates the session, executes DSH's
host-side `/permission <preset>` command, and only then submits the model task. The DSH presets mean:

- `read-only`: file mutations are denied unless the user grants a wider one-shot operation.
- `workspace-write`: DSH's Web default; file mutations are confined to the session workspace and
  supported temporary roots, while reads/network/process visibility are not confined by that file policy.
- `danger-full-access`: no DSH file-sandbox restriction; disabled by this bridge until the operator opts in.

When `dsh_wait` sees an approval, it returns the exact `rpcId`, `approvalId`, tool, call id, reason,
and whether MCP responses are enabled. With the safe default, the user answers in DSH Web. If the
operator sets `DSH_ENABLE_APPROVAL_RESPONSES=true`, Codex can call `dsh_answer_approval` with
`allow_once` or `reject`, but only after the user explicitly decides. No persistent or automatic
approval mode is implemented.

A different loopback port can be configured with `DSH_WEB_URL`. Remote hosts, HTTPS URLs,
credentials, paths, queries, and fragments are rejected deliberately.

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
