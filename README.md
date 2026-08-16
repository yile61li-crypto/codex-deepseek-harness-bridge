# DeepSeek Harness Bridge for Codex

A local MCP bridge that lets Codex start or reuse a
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web runtime and open it in Codex's built-in browser. Both clients use
the same DSH process and session store, so delegated sessions and live tool activity remain visible
in the DSH Web UI.

[中文说明](README.zh-CN.md)

## Requirements

- Node.js 22.19 or newer.
- The pinned `@deepseek-ai/dsh` dependency, or an already running compatible DSH Web runtime.
- A DSH version compatible with the developer-preview `session.*` Web RPC and event streams. The
  bridge is currently tested against the pinned DSH `0.1.0-rc.6` release candidate.

## Install in Codex

Install this repository as a Codex plugin or add it to a compatible Agent Plugins marketplace.
The included `.mcp.json` starts the MCP server with Node and connects only to the loopback DSH URL.
After dependencies are installed, ask Codex to “open DeepSeek Harness”: the plugin ensures the
runtime first and then opens the verified URL in Codex's own right-side Browser panel. On Codex
builds without that host UI tool, it returns the exact loopback URL for manual opening instead.

For a source checkout, install the pinned official runtime once from the plugin directory:

```sh
git clone https://github.com/yile61li-crypto/codex-deepseek-harness-bridge.git
cd codex-deepseek-harness-bridge
npm ci --ignore-scripts
npm rebuild node-pty --foreground-scripts
```

The explicit rebuild is required because managed DSH startup loads `node-pty`; Linux packages build
its native module locally when no matching prebuild is available.

The bridge can still connect to an externally started DSH without this dependency; managed startup
requires it unless `DSH_RUNTIME_COMMAND` is configured.

After installation, start a new Codex task so the MCP tool catalog is refreshed.

## Tools

| Tool | Purpose |
|---|---|
| `dsh_runtime_status` | Inspect local DSH reachability and managed-start configuration. |
| `dsh_ensure_runtime` | Reuse a healthy runtime or safely start local DSH. |
| `dsh_health` | Check DSH plus bridge policy and optional capabilities. |
| `dsh_list_workspaces` | List registered workspaces and grouped session ids. |
| `dsh_create_workspace` | Explicitly register an allowed existing directory when installation-level creation is enabled. |
| `dsh_set_default_permission` | Explicitly persist the default permission for future tasks. |
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
| `dsh_get_attachment` | Fetch one session-authorized image for an isolated Codex vision subagent. |
| `dsh_cancel` | Cancel the active turn without deleting queued work. |

`dsh_start_task` and `dsh_send` invoke the model configured in DSH and may incur usage. The bridge
never auto-approves tools or answers questions.

## New session or continued session

The default is **reuse when related, create only at a real boundary**. One project normally keeps
planning, implementation, testing, debugging, review, documentation, and follow-up questions in
the same exact DSH session. Another MCP call, a completed turn, or elapsed time is not a reason to
start over.

- To continue related work, retain the `sessionId` returned by `dsh_start_task` or `dsh_fork_session` and
  pass it to every later `dsh_send`. The result includes `waitAfterSeq`; pass that value to
  `dsh_wait.after_seq`, and pass `promptRpcId` to `dsh_wait.prompt_rpc_id`. Together they prevent
  an older answer—or the turn ahead of a queued follow-up—from being reported as the requested result.
- Start a new session only when the user asks for one, the objective is materially unrelated, the
  workspace or trust boundary changes, or independent parallel work needs isolation. Choose a
  registered `workspace_id` or an absolute `cwd`. If neither a tool
  argument nor an installation default exists, `dsh_start_task` fails with `task-target-required`;
  Codex should list workspaces/sessions and ask the user what to do.
- When no exact session is bound, Codex may inspect bounded session metadata/history. It continues
  automatically only when one candidate clearly matches both workspace and objective; ambiguous
  candidates require one short user question. Recency alone is never sufficient.
- Creating a workspace/group is allowed only through the separate `dsh_create_workspace` tool after
  the user explicitly requests it. The required `user_confirmed=true` flag must never be inferred.
  Operators must also opt in with `DSH_ENABLE_WORKSPACE_CREATION=true` and configure non-empty
  allowed roots; the tool registers an existing canonical local directory below one of those roots
  and never creates or deletes filesystem content.
- Writable permissions require a registered `workspace_id`. An arbitrary `cwd` is accepted only
  for `read-only`, preventing a model-selected path from enlarging the write sandbox.

The bridge deliberately has no process-wide "last session", because concurrent Codex tasks could
silently write to the wrong conversation. The binding is task-local: `dsh_start_task` means **new
conversation**, while `dsh_send` means **continue this exact conversation**.

## Configuration

| Environment variable | Default | Meaning |
|---|---|---|
| `DSH_WEB_URL` | `http://127.0.0.1:3080` | Existing DSH Web runtime. Only loopback HTTP URLs are accepted. |
| `DSH_RUNTIME_COMMAND` | unset | Optional DSH executable; otherwise the pinned official `@deepseek-ai/dsh` dependency is used. |
| `DSH_RUNTIME_ARGS_JSON` | unset | JSON string array prepended before the fixed `web --host/--port` arguments for a custom executable. |
| `DSH_RUNTIME_CWD` | dedicated state directory | Optional managed-runtime working directory; never defaults to plugin source and remains independent of task workspace selection. |
| `DSH_RUNTIME_LOG_DIR` | user state directory | DSH stdout/stderr log location, isolated from MCP stdout. |
| `DSH_RUNTIME_START_TIMEOUT_MS` | `30000` | Health-wait timeout in milliseconds, from 1000 to 120000. |
| `DSH_MAX_ATTACHMENT_BYTES` | `5242880` | Maximum decoded image size returned to an isolated vision subagent; configurable from 1 to 25 MiB. |
| `DSH_MAX_PROMPT_CHARS` | `50000` | Maximum JavaScript string length accepted by a new or continued model prompt; configurable from 1000 to 1000000. |
| `DSH_DEFAULT_PERMISSION` | `read-only` | Initial default used until the user persistently changes it. |
| `DSH_MAX_PERMISSION` | `danger-full-access` | Bridge-enforced request ceiling. Lower it to `workspace-write` or `read-only` when desired. |
| `DSH_SETTINGS_FILE` | `~/.deepseek-harness-bridge/settings.json` | Optional absolute path for persistent bridge settings. |
| `DSH_DEFAULT_WORKSPACE_ID` | unset | Registered workspace used when a new task omits its target. |
| `DSH_DEFAULT_CWD` | unset | Read-only fallback directory; mutually exclusive with the default workspace id. |
| `DSH_ENABLE_WORKSPACE_CREATION` | `false` | Enable the user-confirmed workspace registration tool; requires non-empty allowed roots. |
| `DSH_ALLOWED_WORKSPACE_ROOTS_JSON` | `[]` | JSON array of existing absolute local directories beneath which workspaces may be registered. |
| `DSH_ENABLE_APPROVAL_RESPONSES` | `false` | Expose working approval responses through MCP instead of Web-UI-only handling. |
| `DSH_ENABLE_QUESTION_RESPONSES` | `false` | Permit exact question answers/cancellation through MCP instead of Web UI. |
| `DSH_MAX_CONCURRENT_WAITS` | `4` | Bound long-lived event streams. |
| `DSH_MODEL_REQUESTS_PER_MINUTE` | `12` | Bound task creation and continuation calls that may consume model usage. |

Users can configure permissions at two levels:

1. Per task: pass `permission` to `dsh_start_task`, or use `dsh_set_permission` for an existing session.
2. Installation default: edit the plugin root `.mcp.json` `env` values, restart Codex, and start a new task so the MCP server reloads.

The default may never exceed the maximum. The installed bridge permits every DSH preset up to
`danger-full-access`, but each new task initially starts as `read-only` unless its tool call explicitly
selects a higher permission. A user may explicitly call `dsh_set_default_permission` to persist a
different default for future tasks. The required confirmation must not be inferred, and neither a
ceiling nor default change upgrades an existing session. A persisted default overrides the initial
environment value but is always capped by `DSH_MAX_PERMISSION`.

The ceiling is enforced at the bridge request boundary, not as an atomic lock over DSH session
state. Another local DSH Web or API client can change the same session's permission concurrently
or immediately after the bridge check. Do not treat the bridge as isolation from other trusted
local clients; control those clients when a session needs a stable permission policy.

Every `dsh_start_task` may override `permission`; the bridge creates the session, executes DSH's
host-side `/permission <preset>` command, and only then submits the model task. The DSH presets mean:

- `read-only`: file mutations are denied, but DSH's file policy does not confine reads, network, or process visibility.
- `workspace-write`: DSH's Web default; file mutations are confined to the session workspace and
  supported temporary roots, while reads/network/process visibility are not confined by that file policy.
- `danger-full-access`: no DSH file-sandbox restriction; available when explicitly selected for a registered workspace.

When `dsh_wait` sees an approval or question, it returns the exact request identity, payload,
observation time, and `mayBeStale=true`. The DSH Web UI remains the safe default. Optional MCP
responses accept only an exact pending identity; an already-resolved request is returned
idempotently as `already_resolved`. Approval supports only `allow_once` or `reject`. No persistent
or automatic response mode exists. Treat both MCP response channels as advanced, experimental
operator controls; they are disabled by default and are not an out-of-band human-consent system.

`dsh_history` returns `firstSeq` and `nextBeforeSeq`; use the latter as the next exclusive
`before_seq` cursor. Tool arguments and output are excluded by default and strictly truncated when
`include_tools=true` to limit sensitive output and token usage.

### Experimental isolated visual relay

DSH currently has no dependable vision path, so history and wait results expose only bounded image
metadata to the main Codex conversation. The bundled skill requires a fresh Codex collaboration
subagent with `fork_turns="none"` to call `dsh_get_attachment`, inspect the MCP image, and return only
compact structured text. The parent never receives the image or Base64 and may relay that text back
to the exact DSH session. PNG, JPEG, WebP, and GIF are accepted; the bridge verifies the session
reference, media metadata, Base64 length, and configured size limit.

This experimental isolation is an explicit skill contract rather than cryptographic caller authentication: the
public plugin format cannot register a custom subagent type, so it uses Codex's generic collaboration
subagent. If subagents are unavailable, the skill fails closed unless the user explicitly permits
the parent conversation to fetch the image.

A different loopback port can be configured with `DSH_WEB_URL`. Remote hosts, HTTPS URLs,
credentials, paths, queries, and fragments are rejected deliberately.

`dsh_ensure_runtime` is idempotent: a healthy DSH on the target port is reused, never restarted or
terminated. A managed runtime is launched by Node directly through the official `lib/bin.js` with
`shell=false`, a fixed loopback host, and the configured port. Its logs never share the MCP JSON-RPC
stdout. MCP cannot manipulate Codex windows by itself, so the bundled skill performs the final host
handoff to Codex's built-in Browser; it does not open the system browser or invent an `.app.json`
webview capability.

## Development

```sh
npm run check
npm test
npm run test:live
npm run test:mcp-live
npm run package:smoke
```

Neither live probe submits a prompt. `test:live` is read-only; `test:mcp-live` idempotently ensures
the runtime before exercising the complete Codex stdio MCP path, so it may start local DSH when the
configured port is vacant. `package:smoke` packs and installs the exact publishable artifact, runs
its packaged verification commands, and probes MCP initialization plus tool discovery.

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

## Project status and trademarks

This is an independent community integration. It is not affiliated with, sponsored by, or endorsed
by DeepSeek or OpenAI. DeepSeek, Codex, OpenAI, and related names identify the systems with which
the project interoperates; their trademarks remain the property of their respective owners.

## License

MIT
