# Changelog

## 0.1.4 - 2026-10-14

- Peak waiting moved before the provider attempt. A normal interactive request (and a queue-owned auto task) that reaches peak pricing is now deferred at OpenCode v2's `model.request` hook, which runs while the request is being prepared and before the provider attempt (and its response-header timeout) exists.
- This removes the `Timed out waiting for response headers` failure for requests submitted during peak: no provider attempt is open for hours, no retry is required as the waiting mechanism, and the same session continues the same turn at the next off-peak transition with no synthetic continuation prompt.
- The HTTP/WebSocket transport guard remains the final hard barrier: no provider request can cross a blocked pricing window, and `queue`/`guard`/OFF behavior is unchanged (handled exactly as before by the transport guard).
- Requests that start during off-peak and cross into peak keep the v0.1.3 retry-veto recovery (retryable failure during peak → persisted same-session continuation at the boundary).
- A held primary interactive request persists a deferral while it waits and removes it on normal release, so a plugin reload or server restart during peak still delivers exactly one same-session continuation once the allowed window arrives.
- New safety net: OpenCode's `session.execution.interrupted` events are handled with origin-aware semantics. An `inactivity` interrupt of a deferred session keeps the deferral and continues the same session at the next allowed window; a `user` interrupt clears a deferral and aborts the hold; `superseded`/`shutdown` abort the hold and let the session's own recovery own the outcome.
- The built-in `deepseek-opencode-go` policy now treats Chinese statutory public holidays as full-day OFF_PEAK. The policy model supports explicit full-day OFF_PEAK exception calendars (year, dates, source URL, verification date, description), evaluated on the calendar's own time zone and overriding every weekday peak window. The 2026 China calendar from the State Council notice ships in `src/holidays.ts`; weekend make-up workdays stay OFF_PEAK; years without a calendar keep the deterministic weekly schedule; `nextTransition` skips holiday peak windows.
- Added deterministic regression coverage for the pre-model deferral (release at the scheduled boundary, zero provider traffic), passivity outside `auto`/ON/peak, untracked/unknown handling, the queue-owned deferral, deferral persistence across reload, user/inactivity/shutdown interrupts, and the full 2026 holiday calendar (periods, make-up workdays, adjacent days, `nextTransition`, calendar time zone, unknown years, validation).

## 0.1.3 - 2026-10-13

- Retryable provider/network failures that happen after peak pricing begins no longer lose the work. The plugin registers OpenCode v2's supported `retry` hook and vetoes retries while pricing is blocked (`decision = { retry: false }`), so no retry attempt reaches the provider during peak.
- A queue-owned `auto` task that fails retryably during peak moves to `WAITING_OFFPEAK` (not `FAILED`), keeps its session ID, and continues the same session at the next off-peak transition with the safe continuation prompt.
- A normal interactive session that fails retryably during peak is recorded with minimal recovery metadata in OpenCode plugin storage and continues the same session the same way. `/offpeak status` reports it as `Recovery: N session(s) waiting for off-peak`.
- Non-retryable failures still end as `FAILED`/error; retryable failures while pricing is allowed keep OpenCode's normal retry behavior; OFF, `queue`, and `guard` modes are unchanged. The continuation never replays the failed provider request, never creates a new session, and never duplicates the user prompt.
- Added deterministic regression coverage for the retry veto, the task transition to `WAITING_OFFPEAK`, the interactive recovery and its single delivery, location-scoped persistence across restart, supersede-on-new-request, non-retryable failures, OFF/queue/guard passivity, UNTRACKED/UNKNOWN pass-through, and the override case.

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
