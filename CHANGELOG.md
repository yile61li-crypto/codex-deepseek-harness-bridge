# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.1] - 2026-08-17

### Fixed

- Removed the plugin-root `cwd` override that some Codex builds treated as a literal relative path,
  preventing the MCP server from starting on Windows.
- Packed-artifact smoke testing now launches the MCP server from outside the installed package so
  working-directory regressions are caught before release.
- Codex builds without the browser handoff host tool now receive the exact loopback URL for manual
  opening instead of losing access to an otherwise healthy DSH runtime.

## [0.6.0] - 2026-08-17

### Added

- Default-off workspace registration with administrator-controlled canonical local root allowlists.
- Configurable prompt-length limits, bounded HTTP response reads, and private managed-runtime log permissions.
- Packed-artifact installation and MCP discovery smoke testing, official-registry production dependency auditing, and npm Dependabot coverage.

### Changed

- `dsh_start_task` can no longer adopt an existing session id; new sessions and exact-session continuation now have separate public tool contracts.
- Persisted default permission changes are refreshed by already-running bridge processes before future task creation and policy reporting.
- Public compatibility claims now cover only the pinned DSH `0.1.0-rc.6` release candidate.
- Permission-ceiling documentation now describes bridge request-boundary enforcement and the non-atomic interaction with other trusted local DSH clients.
- Visual relay and opt-in MCP approval/question responses are explicitly labeled experimental.
- Plugin validation now ships inside the npm archive, and all public version surfaces report `0.6.0`.

### Security

- Workspace registration rejects filesystem roots, remote/device paths, and targets outside configured allowed roots.
- Attachment and generic RPC responses are rejected before unbounded response allocation.

## [0.5.1] - 2026-08-17

### Changed

- Related work now reuses an exact task-local DSH session by default; new sessions are reserved for explicit, unrelated, cross-workspace, trust-boundary, or independent parallel work.
- Ambiguous session selection asks the user instead of choosing by recency or creating a new ungrouped conversation.

## [0.5.0] - 2026-08-17

### Changed

- The default permission ceiling now exposes DSH's highest `danger-full-access` preset while new tasks remain read-only unless explicitly elevated.
- New DSH workspace/group registration is available only through an explicit, user-confirmed tool call and is never used as an implicit task fallback.
- Users can explicitly persist the default permission for future tasks without editing plugin files; the configured maximum remains authoritative.

### Added

- Session-authorized image attachment retrieval plus a fail-closed Skill workflow that keeps raw images in a fresh Codex vision subagent and returns only structured text to the parent conversation.

## [0.4.0] - 2026-08-16

### Added

- Managed DSH runtime discovery and idempotent local startup through the pinned official CLI dependency.
- A plugin skill that opens the verified loopback DSH URL in Codex's built-in browser side panel.
- Operator overrides for the runtime executable, argument prefix, working directory, log directory, and startup timeout.

### Changed

- The bridge now works when DSH is not already running; an existing runtime is always reused and never terminated.

## [0.3.0] - 2026-08-16

### Added

- Seventeen bounded MCP tools covering workspace/preset discovery, session list/search/detail,
  persistent continuation, rename/fork, model catalog, permission control, history, and user-action handoff.
- Independent default and maximum permission controls, deliberate workspace targeting, model-call
  rate limiting, and concurrent-wait limits.
- Exact question answering/cancellation behind an opt-in gate.
- Correct history cursors, optional truncated tool activity, and per-turn `waitAfterSeq` handoff.
- Cross-platform Node.js 22 CI for Windows and Linux.
- Repository-local plugin manifest validation and publish-archive inspection.
- Public contribution guidance, issue forms, pull request checklist, and community standards.

### Changed

- New sessions default to read-only, writable sessions require a registered DSH workspace, and
  missing targets fail closed instead of silently entering the ungrouped project.
- Agent preset selection is omitted unless explicitly requested, allowing DSH deployment defaults.
- Expanded package metadata and npm scripts for reproducible contributor and release workflows.

### Fixed

- Prevented tool arguments from escalating above the operator's permission ceiling.
- Prevented arbitrary model-selected paths from becoming writable sandbox roots.
- Preserved exact approval/question identities and handled already-resolved response races.
- Reported WebSocket disconnects, pre-cancelled waits, typed JSON-RPC ids, and prior-turn output correctly.

## [0.2.0] - 2026-08-16

### Added

- Per-session `read-only`, `workspace-write`, and gated `danger-full-access` controls.
- Explicit one-shot approval responses, disabled by default.

### Fixed

- Preserved the newest WebSocket event sequence after history reconciliation.
- Distinguished operator cancellation from connection failure.

## [0.1.0] - 2026-08-16

### Added

- Initial dependency-free MCP bridge for visible local DeepSeek Harness sessions.
