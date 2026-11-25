# Roadmap

## Current: 0.5.x

- OpenCode CLI v2.0.26 API adapter; compatibility extended through 2.4.1, including background compaction.
- Two independent persistent client globals: CLI Protection and Desktop Protection.
- One per-chat setting: follow the client global, always protect, or allow peak. The most recently opened client owns the chat default.
- Native Desktop settings page (`./gui-experimental`) with the two global switches and the per-chat selector.
- Canonical commands shared by CLI and Desktop: `/offpeak status`, `/offpeak on|off`, `/offpeak chat on|off|auto`, `/offpeak cli on|off`, `/offpeak desktop on|off`.
- DeepSeek via OpenCode Go policy.
- Request-boundary model, HTTP, and experimental WebSocket guard; same-session automatic hold and recovery.
- Fail-closed validation for unknown pricing and invalid configuration.

## Possible later work

- Add provider policies after verifying their published pricing and schedule.
- Expand the supported OpenCode v2 range after compatibility testing against each release.
- Replace the Desktop draft first-request hold with a supported pre-submit registration hook if a future GUI/TUI SDK exposes one.
- Add an explicit ownership-reset control only if a supported lifecycle event can prove a client has closed a session; a lease or heartbeat is out of scope.

No roadmap item is part of the current release unless it is listed above as current.
