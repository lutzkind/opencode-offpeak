# Repository instructions

## Start here

- Run `git status` before making changes. A local checkout is not proof that it matches the canonical `origin/main`; verify the repository and branch before editing or reporting state.
- Use `/root/REPO_MAP.md` as the host-level repository map when working on the canonical host checkout.
- Read `ARCHITECTURE.md`, `DECISIONS.md`, and `HANDOFF.md` before changing lifecycle or pricing-policy behavior. `ROADMAP.md` describes future work and is not current scope unless explicitly promoted.

## Commands

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm pack --dry-run`

Tests use fixtures and must not incur provider charges.

## Production

- This repository contains one OpenCode v2 package with `server`, `tui`, and `gui-experimental` entrypoints. The server remains the only pricing authority. Do not add a parallel daemon, DB, scheduler, queue, provider proxy, or second server initialization in the GUI bundle.
- Request enforcement belongs at the v2 model HTTP/WebSocket hooks. Invalid config, unknown models for a configured provider, unregistered/shared client sessions, and ambiguous restart state must fail closed.
- Preserve `/offpeak off` as passive automation. It never starts work, erases task/session state, or implies a price override.
- Keep the OpenCode support range explicit and test the installed API version before expanding it.
- Do not place credentials, auth files, provider responses, or private user prompts in documentation, issues, or handoffs.
