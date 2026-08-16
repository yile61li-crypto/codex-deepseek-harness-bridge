---
name: deepseek-harness
description: Start, open, inspect, and operate DeepSeek Harness from Codex. Use when the user asks to open or view DSH in Codex, start its local Web runtime, delegate a task to DeepSeek Harness, inspect its sessions, continue one exact DSH conversation, or handle a DSH approval or question.
---

# DeepSeek Harness

## Open DSH in Codex

1. Call `dsh_ensure_runtime` with no arguments. It starts the bundled DSH Web runtime only when the configured loopback URL is not already healthy.
2. Require `reachable: true` in the result. Use its exact `baseUrl`; never substitute a remote URL.
3. Check Codex in-app Browser tabs first. If one already has the exact `baseUrl`, claim and show that tab and mark it deliverable instead of opening a duplicate.
4. Otherwise call Codex's `open_in_codex` host tool with `target: {type: "browser", url: baseUrl}` and `placement: "right"`.
5. Report that the page opened only after the browser or host tool succeeds. MCP alone cannot control Codex UI.

Keep the page visible when the user asks to watch DSH work.

## Choose the conversation deliberately

- Use `dsh_start_task` only for a new conversation. Select an existing `workspace_id`; if the user did not specify a target, list workspaces and sessions, then ask instead of creating an ungrouped session.
- Use `dsh_send` with an exact `session_id` for every continuation. Never use a process-global "last session".
- Pass `promptRpcId` and `waitAfterSeq` from start/send into `dsh_wait` so an earlier turn cannot be mistaken for the requested result.
- Default to read-only. Never raise the configured permission ceiling or answer approvals/questions without the user's explicit decision.

## Handle failures

- If runtime startup fails, return the structured error and log path. Do not install software or switch to a remote DSH host automatically.
- An already-running runtime is external ownership. Never stop or restart it.
- If browser opening fails after DSH becomes healthy, leave DSH running and report only the UI handoff failure.
