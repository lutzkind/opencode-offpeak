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
- Request enforcement belongs at the v2 model and HTTP/WebSocket hooks. Invalid config, unknown models for a configured provider, and chats no client has registered must fail closed.
- Protection is exactly two client globals plus one per-chat setting (`on`, `off`, follow-global). An explicit chat setting wins over either global; there is no installation-wide enable switch and no queue.
- Keep the OpenCode support range explicit and test the installed API version before expanding it.
- Do not place credentials, auth files, provider responses, or private user prompts in documentation, issues, or handoffs.
