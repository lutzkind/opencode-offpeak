# Roadmap

## Current: 0.1.x

- OpenCode CLI v2.0.26 API adapter.
- DeepSeek via OpenCode Go policy.
- Persistent sequential queue, ON/OFF, status/list/cancel/retry/resume controls.
- Request-boundary HTTP and experimental WebSocket guard.
- Same-session automatic pause/resume and task-scoped 15-minute override.
- Fail-closed validation and conservative ambiguous-crash recovery.

## Possible later work

- Add provider policies after verifying their published pricing and schedule.
- Expand the supported OpenCode v2 range after compatibility testing against each release.
- Improve queue inspection UI if OpenCode's current TUI API supports a stable panel surface.
- Add safe migration tooling if the stored queue schema changes.

No roadmap item is part of the current release unless it is listed above as current.
