# Changelog

## 0.1.2 - 2026-10-12

- Normal interactive OpenCode requests now wait at the pricing boundary in `auto` mode instead of being discarded. The same request and session proceed automatically at the policy's next off-peak transition, with no second message, no duplicate prompt, no new session, and zero provider traffic while pricing is blocked.
- The interactive hold uses the existing shared signal and one boundary timer (`nextTransition`); it adds no daemon, scheduler, database, or polling loop, and fails closed if the plugin shuts down while a request is waiting.
- `/offpeak status` reports held interactive requests (`Interactive: N request(s) waiting for off-peak`).
- `queue`/`guard` modes still block interactive peak requests immediately, and OFF stays passive: it never releases a held request and remains no price override.
- Added deterministic manual-clock regression tests for the interactive hold, boundary release, single release, same-session preservation, OFF passivity, fail-closed shutdown, UNKNOWN/UNTRACKED handling, and unchanged queue-owned auto resume.

## 0.1.1 - 2026-10-11

- Both entrypoints now declare and enforce the tested OpenCode support range `>=2.0.26 <2.1.0` through `engines.opencode` plus a startup compatibility check. Unsupported hosts fail with an actionable version error instead of the confusing `Keymap.Provider is missing` runtime failure.
- The TUI entrypoint uses the documented `Plugin.define(...)` form and registers `/offpeak` through `context.keymap.layer(...)` on the supported host API.
- Added `/offpeak remove <task-id>` for deleting terminal (`COMPLETED`, `FAILED`, `CANCELLED`) tasks from the queue; active tasks must be cancelled first.
- Added regression coverage for the manifest compatibility declaration, TUI export resolution, entrypoint shape, server/TUI separation, clean packed-install loading, compatibility enforcement, and a real OpenCode v2 TUI smoke test that exercises `/offpeak status`.

## 0.1.0 - 2026-10-09

- Initial OpenCode CLI v2 server and TUI plugin package.
- Persistent task queue, ON/OFF control, DeepSeek/OpenCode Go pricing guard, automatic same-session pause/resume, and task-scoped 15-minute override.
- Fail-closed recovery for ambiguous `RUNNING` tasks after a server restart.
