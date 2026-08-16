# Security policy

The bridge accepts only loopback `http://` endpoints (`127.0.0.1`, `localhost`, or `::1`).
It intentionally refuses LAN and Internet DSH endpoints because the current DSH Web API uses a
local trust boundary rather than user authentication.

The bridge never answers DSH approval or question requests automatically. Both response channels
are Web-UI-only by default. Their MCP forms are advanced, experimental operator controls rather
than an out-of-band human-consent system. Operators may enable them independently, but tools accept
only exact pending RPC identities. Approvals support only `allowed-once` or `rejected`; no
remembered policy or automatic response mode exists. A `not-pending` receipt is treated as an
idempotent `already_resolved` result because another client may have handled the request first.

New tasks default to `read-only`. `DSH_MAX_PERMISSION` is enforced at the bridge request boundary
for both new and existing sessions; a per-tool argument cannot exceed it. It is not an atomic lock
over DSH state: another trusted local DSH Web or API client can change the same session concurrently
or immediately after the bridge check. Writable modes require an existing operator-registered DSH
workspace id. Workspace registration is disabled by default and, when enabled, is limited to
existing canonical local directories beneath administrator-configured allowed roots. Arbitrary
`cwd` targets are read-only, absolute, and may not be a filesystem root, preventing a model from
choosing a broad write sandbox. Full access removes DSH's file-sandbox restriction and should be
enabled only for disposable or trusted workspaces.
A DSH session still has every non-filesystem capability granted by its selected Agent Preset, so
review both the preset and permission mode before delegating work.

The bridge intentionally has no global "last session". Continuing work always requires an exact
session id so concurrent Codex tasks cannot cross-write into another conversation. Model-submitting
tools are rate limited and prompt length is capped; concurrent event waits, response bodies,
attachments, and history text are bounded. Tool arguments/results are omitted unless explicitly
requested. Managed runtime logs use private directory and file permissions where the platform
supports POSIX modes.

Please report security issues privately through the repository's
[Security → Report a vulnerability](https://github.com/yile61li-crypto/codex-deepseek-harness-bridge/security/advisories/new)
flow once it is enabled. Until that private channel is available, do not include exploit details,
credentials, private paths, or prompts in a public issue.
