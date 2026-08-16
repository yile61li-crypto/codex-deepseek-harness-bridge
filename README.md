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
| `dsh_health` | Check DSH plus bridge policy and optional capabilities. |
| `dsh_list_workspaces` | List registered workspaces and grouped session ids. |
| `dsh_list_agent_presets` | List available and broken agent presets. |
| `dsh_list_sessions` | List and filter recent sessions. |
| `dsh_get_session` | Read one exact session and optional bounded history. |
| `dsh_search_sessions` | Search session text when the DSH query index is enabled. |
| `dsh_get_models` | Inspect the current model and routable model catalog. |
| `dsh_start_task` | Always create a new visible session and submit a model task. |
| `dsh_rename_session` | Change session metadata only. |
| `dsh_fork_session` | Fork at a completed turn boundary without a model call. |
| `dsh_set_permission` | Change one session's DSH permission preset. |
| `dsh_send` | Continue one exact session by queuing or steering a message. |
| `dsh_wait` | Wait for completion or return structured approval details. |
| `dsh_answer_approval` | Allow once or reject an exact pending approval when explicitly enabled. |
| `dsh_answer_question` | Answer or cancel an exact question batch when explicitly enabled. |
| `dsh_history` | Read paginated, bounded messages and optional tool activity. |
| `dsh_cancel` | Cancel the active turn without deleting queued work. |

`dsh_start_task` and `dsh_send` invoke the model configured in DSH and may incur usage. The bridge
never auto-approves tools or answers questions.

## New session or continued session

The bridge does not maintain a process-wide "last session" because concurrent Codex tasks could
silently write to the wrong DSH conversation.

- To continue work, retain the `sessionId` returned by `dsh_start_task` or `dsh_fork_session` and
  pass it to every later `dsh_send`. The result includes `waitAfterSeq`; pass that value to
  `dsh_wait.after_seq`, and pass `promptRpcId` to `dsh_wait.prompt_rpc_id`. Together they prevent
  an older answer—or the turn ahead of a queued follow-up—from being reported as the requested result.
- To start new work, choose a registered `workspace_id` or an absolute `cwd`. If neither a tool
  argument nor an installation default exists, `dsh_start_task` fails with `task-target-required`;
  Codex should list workspaces/sessions and ask the user what to do.
- Writable permissions require a registered `workspace_id`. An arbitrary `cwd` is accepted only
  for `read-only`, preventing a model-selected path from enlarging the write sandbox.

`dsh_start_task` always means **new conversation**. `dsh_send` always means **continue this exact
conversation**.

## Configuration

| Environment variable | Default | Meaning |
|---|---|---|
| `DSH_WEB_URL` | `http://127.0.0.1:3080` | Existing DSH Web runtime. Only loopback HTTP URLs are accepted. |
| `DSH_DEFAULT_PERMISSION` | `read-only` | Permission applied before every new task. |
| `DSH_MAX_PERMISSION` | `workspace-write` | Hard ceiling that tool arguments cannot exceed. Set `read-only` for an absolute read-only bridge. |
| `DSH_DEFAULT_WORKSPACE_ID` | unset | Registered workspace used when a new task omits its target. |
| `DSH_DEFAULT_CWD` | unset | Read-only fallback directory; mutually exclusive with the default workspace id. |
| `DSH_ENABLE_APPROVAL_RESPONSES` | `false` | Expose working approval responses through MCP instead of Web-UI-only handling. |
| `DSH_ENABLE_QUESTION_RESPONSES` | `false` | Permit exact question answers/cancellation through MCP instead of Web UI. |
| `DSH_MAX_CONCURRENT_WAITS` | `4` | Bound long-lived event streams. |
| `DSH_MODEL_REQUESTS_PER_MINUTE` | `12` | Bound task creation and continuation calls that may consume model usage. |

Users can configure permissions at two levels:

1. Per task: pass `permission` to `dsh_start_task`, or use `dsh_set_permission` for an existing session.
2. Installation default: edit the plugin root `.mcp.json` `env` values, restart Codex, and start a new task so the MCP server reloads.

The default may never exceed the maximum. Full access therefore requires
`DSH_MAX_PERMISSION=danger-full-access` **and** an explicit `danger-full-access` tool argument;
changing the ceiling alone never upgrades a session.

Every `dsh_start_task` may override `permission`; the bridge creates the session, executes DSH's
host-side `/permission <preset>` command, and only then submits the model task. The DSH presets mean:

- `read-only`: file mutations are denied, but DSH's file policy does not confine reads, network, or process visibility.
- `workspace-write`: DSH's Web default; file mutations are confined to the session workspace and
  supported temporary roots, while reads/network/process visibility are not confined by that file policy.
- `danger-full-access`: no DSH file-sandbox restriction; disabled by this bridge until the operator opts in.

When `dsh_wait` sees an approval or question, it returns the exact request identity, payload,
observation time, and `mayBeStale=true`. The DSH Web UI remains the safe default. Optional MCP
responses accept only an exact pending identity; an already-resolved request is returned
idempotently as `already_resolved`. Approval supports only `allow_once` or `reject`. No persistent
or automatic response mode exists.

`dsh_history` returns `firstSeq` and `nextBeforeSeq`; use the latter as the next exclusive
`before_seq` cursor. Tool arguments and output are excluded by default and strictly truncated when
`include_tools=true` to limit sensitive output and token usage.

A different loopback port can be configured with `DSH_WEB_URL`. Remote hosts, HTTPS URLs,
credentials, paths, queries, and fragments are rejected deliberately.

## Development

```sh
npm run check
npm test
npm run test:live
npm run test:mcp-live
```

Both live probes are read-only and never submit a prompt. `test:live` exercises the DSH client;
`test:mcp-live` exercises the complete Codex stdio MCP path.

## Compatibility note

DeepSeek Harness currently labels this surface as developer preview. This project uses its browser
RPC (`/api/session.*`) and WebSocket event streams rather than the Python SDK because the SDK starts
a separate runtime whose sessions are not automatically visible in the existing Web UI.

`host.describe.version` is currently a DSH placeholder (`0.0.1`), not the product release. The
bridge reports it as `reportedHostApiVersion` and probes optional endpoints independently. Session
search may legitimately return `search-disabled` when the deployment does not open its query index.
There is no DSH `session.get` or `session.delete` RPC; this bridge composes session details from
supported list/history calls and does not pretend deletion exists.

Privileged authoring/admin surfaces are deliberately not exposed just to increase the tool count:
model selection may also change DSH's saved default, workspace deletion only unregisters metadata,
and arbitrary local-path image upload would let the bridge read outside the DSH permission sandbox.
Those features require separate safety designs before they can become public MCP tools.

## License

MIT
