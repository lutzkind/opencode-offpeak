# Decisions

## 2026-10-09: Implement independently against OpenCode v2

The package uses the installed OpenCode 2.0.26 plugin API instead of forking a prior queue, scheduler, or legacy peak-guard project. Prior projects were reviewed for scheduling, persistence, and user experience; their code is not included.

## 2026-10-09: One package, server and TUI entrypoints

OpenCode v2 separates server-side plugin hooks from TUI keymap slash commands. Publish one npm package exposing `./server` and `./tui`, bridged by OpenCode's plugin RPC. This retains the requested `/offpeak` UX without a second service.

## 2026-10-09: OpenCode owns session and queue persistence

Queue metadata uses OpenCode's plugin storage. Session IDs are the canonical task execution context. No database or duplicate execution engine is added.

## 2026-10-09: Config file is the canonical persistent toggle

`~/.config/opencode/offpeak.json` stores the enabled flag, mode, display timezone, and policy set. TUI commands atomically update the same file, so configuration and command state cannot silently disagree. OpenCode plugin storage remains the queue store.

## 2026-10-09: Fail closed at request transport boundaries

Use v2 HTTP and experimental WebSocket request hooks immediately before network send. Unknown models under a configured provider, invalid policy data, and unreadable config block the request. An unrelated provider with no policy is explicitly `UNTRACKED`.

## 2026-10-09: OFF is passive automation, not a price override

OFF stops queue starts and auto-resumes, preserves task/session records, and leaves peak requests blocked. Only a visible, expiring, task-scoped `run-now` action grants peak inference.

## 2026-10-09: Same-session pause and resume

Tasks store the OpenCode session ID. At a peak boundary, an `auto` task waits at its next provider request and continues the same session after the configured allowed window returns.

## 2026-10-09: No exact-once claim after a crash

OpenCode documents recovery as at-least-once. A persisted `RUNNING` task with a non-success session outcome is ambiguous. Mark it `FAILED`, preserve the session, and require explicit retry rather than risking a duplicated paid inference. Safe `WAITING_OFFPEAK` tasks continue automatically.

## 2026-10-09: No external wake helper in v0.1

OpenCode's supported background server keeps plugin timers and sessions available after the TUI closes. If the server is stopped, tasks remain durable and resume on server startup. Machine boot startup is delegated to a user's OS service manager; this package does not add a daemon or install host service configuration.

## 2026-10-09: Built-in schedule follows OpenCode Go

The policy matches current OpenCode Go billing windows, which list weekdays in UTC and a 2x peak price/allowance multiplier for these DeepSeek models. It does not substitute direct DeepSeek API holiday terms for OpenCode Go pricing.

## 2026-10-11: GitHub tag installation completes the public release

OpenCode CLI v2 supports npm-compatible Git package specifications, including exact Git tags. The canonical v0.1.0 install is `opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.0`; npm publication is optional and no npm account action is required for installation or use. The npm OIDC workflow remains dormant unless the repository variable `NPM_TRUSTED_PUBLISHING` is explicitly set to `enabled` after npm is bootstrapped and its trusted publisher is configured.

## 2026-10-11: Enforce the tested OpenCode range at startup

The live `Keymap.Provider is missing` failure came from a long-running OpenCode TUI process that predated the plugin and was still executing OpenCode 2.0.18 host code (a deleted binary after an in-place upgrade). OpenCode before 2.0.26 activates TUI plugins outside the Solid keymap provider owner, so the documented `context.keymap.layer()` call in `setup` fails there; the same call works on 2.0.26 (verified in the live TUI and an isolated clean install). The package now declares `engines.opencode: ">=2.0.26 <2.1.0"` and both entrypoints check `context.app.version` before touching host APIs, so unsupported hosts fail with an explicit upgrade message instead of a confusing keymap error. The tested range remains exactly `>=2.0.26 <2.1.0`.

## 2026-10-11: Terminal task records can be removed

`/offpeak remove <task-id>` deletes a `COMPLETED`, `FAILED`, or `CANCELLED` record from the queue document. Active tasks must be cancelled first, and the OpenCode session is never deleted. This keeps queue hygiene possible without weakening the OFF/override semantics or the fail-closed recovery rules.

## 2026-10-13: OpenCode 2.0.27 is covered without code changes

The latest official OpenCode v2 release is 2.0.27; no 2.1 line exists. The `@opencode/plugin` 2.0.26 to 2.0.27 diff has identical file lists and no public API surface change, and the package was validated on the real 2.0.27 binary in an isolated fixture environment (all `/offpeak` commands, interactive hold/release, queue pause/resume, OFF/UNKNOWN/UNTRACKED semantics, retry, persistence across restart) and on the live upgraded server (boundary hold/release, queue resume, `opencode reload` persistence). `engines.opencode` already covers 2.0.27, and the `@opencode/plugin` dependency stays pinned at 2.0.26 as the minimum supported version, so no plugin release was required. The range is not widened until a later minor line (for example 2.1) is actually released and tested.

## 2026-10-12: Interactive requests wait at the boundary in auto mode

A normal interactive OpenCode request for a supported model was thrown away at peak pricing even though the queue-owned `auto` path already waited for the next boundary. The guard now holds the pending interactive request at the transport boundary when the plugin is ON and mode is `auto`: no task record, no new session, no synthesized prompt, and no persistent state. The hold uses the existing shared signal plus one timer for the policy's `nextTransition`, is released exactly once when the plugin is enabled and the policy allows, and is shown as `interactiveWaiting` in `/offpeak status`. `queue` and `guard` modes keep blocking interactive requests immediately; OFF stays passive and never releases a held request; and shutdown fails held requests closed instead of releasing them under uncertain pricing. Tests use a manual clock to prove the release comes from the scheduled boundary itself, not from an external wake-up.

## 2026-10-13: Peak-aware retry recovery uses OpenCode's retry hook

A request that starts during OFF_PEAK can cross into PEAK and then fail with a retryable transport error (`Timed out waiting for response headers`). OpenCode's own retries would either reach the provider during peak or exhaust and fail the turn, and the guard's boundary hold cannot outlast the header-timeout clock, which starts at attempt start. The plugin now registers OpenCode's supported `retry` hook: during PEAK, with the plugin ON in `auto` mode and a retryable failure, it sets `decision = { retry: false }` and marks the work to continue at the next allowed window (a queue task moves to `WAITING_OFFPEAK`; an interactive session is recorded with minimal persisted recovery metadata scoped to the plugin location). The continuation uses the existing safe continuation prompt in the same session; the failed provider request is never replayed. Non-retryable failures stay `FAILED`, OFF/`queue`/`guard` modes and the override semantics are unchanged, and no new runtime, scheduler, database, or polling loop is added. Evidence: OpenCode 2.0.27 retry hook events (attempts 2–5; `provider.transport`/`provider.internal`/`provider.rate-limit` retryable, `provider.invalid-request` terminal at attempt 2) plus isolated real-binary end-to-end runs proving zero provider traffic during peak and automatic same-session continuation.
