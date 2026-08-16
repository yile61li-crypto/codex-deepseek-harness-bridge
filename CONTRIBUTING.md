# Contributing

Thank you for helping make DeepSeek Harness Bridge safer and more useful. Keep changes focused,
observable, and compatible with the local trust boundary described in `SECURITY.md`.

## Development setup

Requirements:

- Node.js 22.19.0 or newer
- npm 10 or newer
- DeepSeek Harness Web only for opt-in live tests

Fork and clone the repository, then run:

```bash
npm run verify
npm run pack:dry-run
```

The project has no runtime npm dependencies. `npm run verify` performs syntax checks, unit and MCP
protocol tests, and a repository-local plugin manifest validation. It does not require a developer's
personal Codex installation or an absolute path outside the repository.

Live tests are separate because they connect to a running local DSH instance:

```bash
npm run test:live
npm run test:mcp-live
```

Never make the ordinary test suite depend on a live model, network service, user account, or approval.

## Making a change

1. Open an issue for behavior changes unless the fix is small and self-explanatory.
2. Add or update deterministic tests before changing protocol or safety behavior.
3. Preserve loopback-only networking and explicit permission boundaries.
4. Run `npm run verify` on a supported platform.
5. Inspect the archive with `npm run pack:dry-run` before requesting review.

Do not silently approve tools, broaden `danger-full-access`, persist approval decisions, or include
credentials and private prompts in test fixtures. Any new privileged behavior must default off and
must be called out in the pull request.

## Pull requests

Keep each pull request reviewable and explain:

- the user-visible behavior;
- the protocol or security impact;
- the exact verification commands and results;
- compatibility considerations for Codex, Node.js, and DSH versions.

Maintainers may ask for a smaller change when a pull request combines unrelated concerns.

## Security reports

Do not open a public issue for a suspected vulnerability. Follow `SECURITY.md` and use the
repository's private **Security → Report a vulnerability** flow once the GitHub repository is
published.

## Releases

This project follows Semantic Versioning and records user-visible changes in `CHANGELOG.md`. Before
publishing a release, maintainers should:

1. set the same version in `package.json` and `.codex-plugin/plugin.json`;
2. finalize the matching changelog section and date;
3. run the Windows and Linux CI matrix;
4. inspect `npm run pack:dry-run` output;
5. configure the Git remote, then add verified `repository`, `homepage`, and `bugs` metadata to
   `package.json`—never publish placeholder URLs;
6. tag the exact reviewed commit.
