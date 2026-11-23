# Roadmap

## Current: 0.4.x

- OpenCode CLI v2.0.26 API adapter; compatibility extended through 2.4.1, including background compaction.
- Independent persistent CLI and Desktop protection defaults, with client-side session registration, shared-session fail-closed handling, and a native Desktop settings page (`./gui-experimental`).
- Canonical two-level commands shared by CLI and Desktop: `/offpeak protection global on|off`, `/offpeak protection chat on|off`, and `/offpeak status`. Desktop registers `/offpeak` through the installed GUI SDK's supported composer slash field.
- Desktop chat list uses actual OpenCode titles, project/repository names, and shortened session IDs, with the full ID available for troubleshooting.
- DeepSeek via OpenCode Go policy.
- Persistent sequential queue, ON/OFF, status/list/cancel/retry/resume controls.
- Request-boundary HTTP and experimental WebSocket guard.
- Same-session automatic pause/resume, interactive auto-mode boundary hold, and task-scoped 15-minute override.
- Fail-closed validation and conservative ambiguous-crash recovery.

## Possible later work

- Add provider policies after verifying their published pricing and schedule.
- Expand the supported OpenCode v2 range after compatibility testing against each release.
- Improve queue inspection UI if OpenCode's current TUI API supports a stable panel surface.
- Add safe migration tooling if the stored queue schema changes.
- Replace the Desktop draft first-request hold with a supported pre-submit registration hook if a future GUI/TUI SDK exposes one.
- Add an explicit ownership-reset control only if a supported lifecycle event can prove a client has closed a session; a lease or heartbeat is out of scope.
- Add an explicit per-chat "force ON against a globally OFF interface" control only if a supported, simple state model is approved; the current nullable override deliberately represents bypass only.

No roadmap item is part of the current release unless it is listed above as current.
