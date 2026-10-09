# Repository instructions

- This repository contains one OpenCode CLI v2 package with `server` and `tui` entrypoints. Do not add a parallel daemon, DB, scheduler, queue, or provider proxy.
- Read `ARCHITECTURE.md`, `DECISIONS.md`, and `HANDOFF.md` before changing lifecycle or policy behavior.
- Request enforcement belongs at the v2 model HTTP/WebSocket hooks. Invalid config, unknown models for a configured provider, and ambiguous restart state must fail closed.
- Preserve `/offpeak off` as passive automation. It never starts work, erases task/session state, or implies a price override.
- Keep the OpenCode support range explicit and test the installed API version before expanding it.
- Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm pack --dry-run` for implementation changes. Tests use fixtures and must not incur provider charges.
- Do not place credentials, auth files, provider responses, or private user prompts in documentation, issues, or handoffs.
