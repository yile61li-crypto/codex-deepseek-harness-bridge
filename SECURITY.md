# Security policy

The bridge accepts only loopback `http://` endpoints (`127.0.0.1`, `localhost`, or `::1`).
It intentionally refuses LAN and Internet DSH endpoints because the current DSH Web API uses a
local trust boundary rather than user authentication.

The bridge never answers DSH approval or question requests automatically. Handle those requests
in the DeepSeek Harness Web UI. A DSH session still has every permission granted by its selected
Agent Preset and permission mode, so review both before delegating work.

Please report security issues privately to the repository maintainers rather than opening a public
issue containing credentials or exploit details.
