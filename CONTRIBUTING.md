# Contributing to OpenArx

Thanks for your interest in contributing. OpenArx is in Public Alpha,
and the project is open to bug reports, feature ideas, and code
contributions.

## Reporting Issues

Before opening a new issue, please search existing issues to avoid
duplicates.

When reporting a bug, include:

- A clear description of what you observed and what you expected.
- Steps to reproduce, with versions and environment details where
  relevant.
- Logs, error messages, or screenshots if applicable.

For feature ideas, describe the use case first — what problem you are
trying to solve — before proposing a specific implementation.

## Pull Requests

1. **Discuss first for non-trivial changes.** Open an issue describing
   the change before writing significant code. This avoids wasted work
   on directions the project will not accept.
2. **Fork the repository** and create a branch off `main` for your
   change. Use a short, descriptive branch name.
3. **Keep changes focused.** One pull request per logical change. Avoid
   mixing refactors with feature work or bug fixes.
4. **Match the existing style.** Run the linter and formatter before
   submitting (`pnpm lint`, `pnpm format`).
5. **Add tests** for new behavior and for bug fixes that exercise the
   regression.
6. **Write clear commit messages.** Explain the why, not just the what.

By submitting a pull request, you agree that your contribution is
licensed under the Apache License 2.0, the same license as the rest
of the project. No separate Contributor License Agreement is required.

## Development Setup

Prerequisites:

- Node.js 20 or later
- pnpm 9 or later
- PostgreSQL 16
- Qdrant (any recent version)

Quick start:

```bash
pnpm install
pnpm build
```

Detailed setup, environment variables, and per-package instructions are
in the main `README.md`.

## Code of Conduct

All contributors are expected to follow the project
[Code of Conduct](CODE_OF_CONDUCT.md). Reports of unacceptable behavior
go to `conduct@openarx.ai`.

## Security

Do not file security issues in the public tracker. See
[SECURITY.md](SECURITY.md) for the responsible disclosure process.

## Questions

For general questions about the project, open a discussion or issue on
GitHub. For broader context on the project goals and architecture, see
the main `README.md`.
