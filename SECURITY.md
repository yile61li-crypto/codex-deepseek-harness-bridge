# Security policy

The bridge accepts only loopback `http://` endpoints (`127.0.0.1`, `localhost`, or `::1`).
It intentionally refuses LAN and Internet DSH endpoints because the current DSH Web API uses a
local trust boundary rather than user authentication.

The bridge never answers DSH approval or question requests automatically. Both response channels
are Web-UI-only by default. Operators may enable them independently, but tools accept only exact
pending RPC identities. Approvals support only `allowed-once` or `rejected`; no remembered policy
or automatic response mode exists. A `not-pending` receipt is treated as an idempotent
`already_resolved` result because another client may have handled the request first.

New tasks default to `read-only`. `DSH_MAX_PERMISSION` is a hard ceiling enforced for both new and
existing sessions; a per-tool argument cannot exceed it. Writable modes require an existing
operator-registered DSH workspace id. Arbitrary `cwd` targets are read-only, absolute, and may not
be a filesystem root, preventing a model from choosing a broad write sandbox. Full access removes
DSH's file-sandbox restriction and should be enabled only for disposable or trusted workspaces.
A DSH session still has every non-filesystem capability granted by its selected Agent Preset, so
review both the preset and permission mode before delegating work.

The bridge intentionally has no global "last session". Continuing work always requires an exact
session id so concurrent Codex tasks cannot cross-write into another conversation. Model-submitting
tools are rate limited, concurrent event waits are bounded, history text is capped, and tool
arguments/results are omitted unless explicitly requested.

Please report security issues privately to the repository maintainers rather than opening a public
issue containing credentials or exploit details.
