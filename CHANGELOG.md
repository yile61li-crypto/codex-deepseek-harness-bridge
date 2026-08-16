# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
