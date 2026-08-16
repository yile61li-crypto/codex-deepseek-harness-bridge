# Security policy

The bridge accepts only loopback `http://` endpoints (`127.0.0.1`, `localhost`, or `::1`).
It intentionally refuses LAN and Internet DSH endpoints because the current DSH Web API uses a
local trust boundary rather than user authentication.

The bridge never answers DSH approval or question requests automatically. Approval responses are
Web-UI-only by default. Operators may explicitly enable one-shot MCP approval responses, but the
tool accepts only the exact pending RPC/approval identities and `allowed-once` or `rejected`.
Questions remain Web-UI-only.

New tasks default to DSH's `workspace-write` preset and may select `read-only`. The bridge rejects
`danger-full-access` unless the operator explicitly enables it through configuration. Full access
removes DSH's file-sandbox restriction and should be limited to disposable or trusted workspaces.
A DSH session still has every non-filesystem capability granted by its selected Agent Preset, so
review both the preset and permission mode before delegating work.

Please report security issues privately to the repository maintainers rather than opening a public
issue containing credentials or exploit details.
