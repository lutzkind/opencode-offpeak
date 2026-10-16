# opencode-offpeak

Queue OpenCode agent tasks, block paid model requests during expensive pricing windows, and resume the **same OpenCode session** when off-peak pricing returns.

`opencode-offpeak` is an OpenCode CLI v2 plugin. Its default policy covers DeepSeek models through OpenCode Go. Pricing is enforced at two lifecycle points: a pre-model deferral and the outbound transport guard. In `auto` mode, a supported request that reaches peak pricing waits at the pre-model hook — before OpenCode creates the provider attempt and its response-header timer — and the same session continues the same turn automatically when off-peak pricing returns, with zero provider traffic while pricing is blocked. The transport guard remains the final hard barrier immediately before OpenCode sends an HTTP request or an experimental WebSocket frame. If a request is already in flight and fails with a retryable provider/network error after peak pricing begins, the retry is stopped before it can reach the provider and the same session continues automatically at the next off-peak window. When one session must deliberately run through a peak window, `/offpeak session off` authorizes verified peak-priced inference for that session alone; every other session stays protected.

> **Compatibility:** OpenCode CLI `>=2.0.26 <2.1.0`. This release targets the v2 plugin API shipped with OpenCode 2.0.26 and is validated against OpenCode 2.0.26, 2.0.27, and 2.0.30. The package declares the range in `engines.opencode` and both entrypoints refuse to initialize on an unsupported host with an actionable error instead of failing later at runtime. Later API versions are not claimed until CI and runtime checks cover them.

## Install

```sh
opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.10
```

This installs the released `v0.1.10` directly from its GitHub tag using [OpenCode v2's supported npm-compatible Git package syntax](https://opencode.ai/v2/docs/plugins). The release includes both server and TUI entrypoints. npm publication is optional future distribution; it is not required to install or use this release.

Restart OpenCode after installation. The plugin defaults to enabled, uses the current system timezone for display, and enforces the built-in DeepSeek/OpenCode Go policy without extra setup.

## Use it

In the OpenCode TUI:

```text
/offpeak status
/offpeak queue Add a focused test for the date parser and update its documentation.
/offpeak list
/offpeak cancel <task-id>
/offpeak remove <task-id>
```

Select the provider and model first. Queueing captures the current model and working directory; it does not send the task prompt to the provider. Tasks run sequentially when policy permits.

```text
/offpeak on
/offpeak off
/offpeak session on
/offpeak session off
/offpeak pricing
/offpeak retry <task-id>
/offpeak resume <task-id>
/offpeak run-now <task-id>
```

- `/offpeak on` persists the enabled setting and resumes queue processing.
- `/offpeak off` persists the disabled setting and pauses automatic starts/resumes.
- `/offpeak session on` restores normal off-peak protection for the current session (the default).
- `/offpeak session off` disables off-peak protection for the current session only: that session's verified peak-priced requests run immediately, and any request it already has waiting for off-peak is released. It is an explicit, session-scoped peak authorization — not a global toggle and not a bypass of `UNKNOWN` or invalid-configuration protection.
- `/offpeak status` shows the toggle, mode, model policy, price state, request decision, next transition, queue counts, held interactive requests, sessions waiting for off-peak recovery, the current session's protection state, and any override.
- `/offpeak list` shows task IDs, states, stored session IDs, and the last failure.
- `/offpeak cancel <task-id>` cancels the task and preserves its session record.
- `/offpeak remove <task-id>` removes a terminal (`COMPLETED`, `FAILED`, or `CANCELLED`) task from the queue. Active tasks must be cancelled first; the OpenCode session is preserved.
- `/offpeak retry <task-id>` explicitly retries a failed task in its stored session.
- `/offpeak resume <task-id>` requests a waiting task's continuation in `queue` mode.
- `/offpeak run-now <task-id>` grants a visible, task-scoped 15-minute peak-price override. It requires the plugin to be ON and can consume OpenCode Go allowance at peak rates.

**Disabling the plugin pauses its automation. It does not mean “run everything regardless of price.”** Queue records and session IDs remain stored. The hard peak guard remains active while the plugin is OFF; OFF never creates an override and never releases a request that is already held at the boundary. A request held in `auto` mode resumes only after the plugin is ON again and pricing allows. The single exception is an explicit per-session grant made with `/offpeak session off` (see below), which applies to that one interactive session.

## What happens at a pricing boundary

In `auto` mode, a supported request that reaches peak pricing first waits at OpenCode's pre-model lifecycle hook (`model.request`), which runs while the model request is being prepared and before OpenCode creates the provider attempt and its response-header timeout. Nothing is sent to the provider while the request waits; the same session and the same request continue the same turn automatically at the policy's next off-peak transition — no second message, no duplicate prompt, no new session, and no synthetic continuation. `/offpeak status` reports held requests (`Interactive: N request(s) waiting for off-peak`). The hold lives in the OpenCode background server process and wakes on the scheduled pricing boundary, not on another message or command.

A queued `auto` task behaves the same way: if it reaches peak pricing before its next provider request, the guard stores `WAITING_OFFPEAK` and the same session waits and continues. Local filesystem and other tool operations already in flight are allowed to settle; the plugin does not kill them when the clock changes.

The same protection covers a manual compact-first workflow: if you compact a session during peak and then send your next prompt, both wait in order — the compaction first, the prompt behind it — and run the same way at the boundary, with nothing reaching the provider before then. If the compaction's hold is lost instead (plugin reload, full server restart, or the inactivity sweep), the plugin records a semantic `pending-compaction` marker and admits OpenCode's own compaction again as soon as the session is idle, keeping it ahead of the prompt that was waiting behind it. A user cancel clears the marker; an interrupted or restarted session recovers it. `/offpeak status` reports it as `Compaction recovery: N session(s) waiting for off-peak`.

The HTTP and experimental WebSocket transport guard still runs immediately before OpenCode sends anything, as the final hard barrier. Requests that arrive while the plugin is OFF, or in `queue`/`guard` mode, are blocked by that guard exactly as before. If the plugin shuts down or the server restarts while a request is waiting, the request fails closed as blocked instead of being sent under an uncertain pricing state; the OpenCode server's own execution-claim recovery resumes sessions interrupted by a crash, and the plugin continues to enforce pricing when they come back.

If OpenCode itself interrupts a waiting session (its location-activity sweep ends a session that has had no durable events for 60 minutes), the plugin keeps the persisted deferral and continues the same session automatically at the next allowed window. A user cancel clears the pending deferral instead, so nothing continues after you cancel.

### Cancelling a held request without interrupting the session

A hold is not always worth waiting out: another plugin can discover that the request it parked is obsolete — for example a free route became usable again — and it is the job of that plugin, not this one, to decide so. `cancelHold` is the generic hook for that decision:

```
rpc.opencode-offpeak.cancelHold { sessionID, reason? }
  -> { cancelled: boolean, state: "refused" | "committed" | "none" | "task", model?: string }
```

- `cancelled: true` — the hold was still waiting. The request is refused at the transport boundary before anything is sent, and OpenCode's own retry machinery decides what happens next. The session is **not** interrupted: no `session.interrupt`, no continuation prompt, no lost turn. The caller typically retries the same execution on the route it prefers.
- `state: "committed"` — the allowed window arrived first and the dispatch decision was already taken. The caller keeps the paid work and waits for the next safe boundary. A hold can only settle one way.
- `state: "none"` / `"task"` — nothing was parked for that session, or the hold belongs to a queue task this plugin owns.

The refusal is deliberately boring: the outgoing request is replaced with a placeholder aimed at a closed loopback endpoint (`127.0.0.1:1`) carrying only the marker header `x-opencode-offpeak-refused`. It holds no credentials, no provider headers, no user data, and no body, it cannot reach any service, and the pricing guard skips it instead of holding it again. This is the only supported way to give OpenCode a retryable failure from a plugin: a hook that throws would end the whole execution instead.

A refusal produced this way is not treated as a provider failure, so the peak-aware retry recovery does not register a continuation for it — the caller that asked for the cancellation owns what happens next, and no work is ever resumed twice.

### Session-scoped off-peak protection (`/offpeak session on|off`)

Sometimes one session should deliberately run through a peak window while every other session stays protected:

```text
/offpeak session off   →  Session off-peak protection disabled.
                          This session may use verified peak-priced inference.
/offpeak session on    →  Session off-peak protection enabled.
                          Peak-priced requests will wait for off-peak.
```

- **Current session only.** The command applies to the interactive session you are in. The session is resolved from OpenCode's supported TUI command context (the focused route, then the active session tab); you never copy a session ID. Run the command from an open session — on the home screen, with no session focused, it refuses with a clear message. `/offpeak session off` never affects another session, never affects background queue tasks, and never disables the plugin globally.
- **Default is ON** for every session. Only explicit overrides are stored; there is no way to accidentally inherit one.
- **Persistent until changed.** The override is stored in OpenCode plugin storage and survives TUI restarts, plugin reloads, and full server restarts. There is no timer, no expiry, and no duration syntax. `/offpeak session on` ends it immediately. When the session is deleted (OpenCode's supported `session.deleted` event), the override is reaped; stale entries for sessions that no longer exist are also cleaned lazily when state is read.
- **Verified PEAK only.** With protection off, a request that evaluates `PEAK` under a verified policy is allowed immediately — primary, compaction, title, and generate requests alike, because they all belong to the session you authorized. `UNKNOWN` models and invalid configuration still fail closed. `OFF_PEAK`, `FLAT`, and `UNTRACKED` behave exactly as before.
- **Waiting work wakes immediately.** If the session already has a request held for off-peak, `/offpeak session off` releases it through the existing engine signal: the same request continues in the same session with no `continue` prompt, no re-sent message, no duplicate provider call, and no polling loop. The TUI shows "Session off-peak protection is OFF. Releasing the held request in this session now." Pending recoveries for that session (a deferred primary, a retry-failure continuation, a pending title, or a pending compaction) also proceed immediately, still in their native order.
- **Already-settled work is never recalled.** A committed dispatch (the allowed window already arrived) or a cancelled/refused hold is unaffected: switching protection off cannot resurrect it, and switching it on never interrupts a running provider request. The next request that crosses the guard during peak waits normally again.
- **Cancellation semantics are preserved.** A hold cancelled through `cancelHold` stays refused regardless of later protection changes.
- **Queue tasks stay separate.** A background queue task never inherits a session override, even when it runs in the same OpenCode session; `/offpeak run-now <task-id>` remains the task-scoped authorization.
- **Global precedence.** `/offpeak session off` is an explicit, session-scoped authorization, newer and more specific than the global automation state: in `auto`, `queue`, and `guard` modes, and even while the plugin is globally OFF, it lets that one session dispatch verified peak-priced work. Everything else stays untouched by the global state: OFF still pauses every queue start and auto-resume, still blocks every session that was not explicitly switched off, still blocks every task, and still never releases a held request by itself.
- **Status output.** `/offpeak status` reports the current session's protection, and while peak pricing is active with protection off it makes the effective behavior explicit — `Pricing: PEAK`, `Session protection: OFF`, `Requests: ALLOWED (session override)`. Pricing is never reported as off-peak when it is peak.
- **Compaction.** With protection off, a manual or automatic compaction during peak runs immediately and leaves no pending-compaction marker; with protection on, the compact-first behavior documented above is unchanged.

### Timeout and retry recovery

A request can start during off-peak, be accepted by the provider, cross into a peak window, and then fail with a retryable provider or network error such as `Timed out waiting for response headers`. That failure is real (the request was already sent), so the plugin's job is to make sure nothing further reaches the provider and the work is not lost. OpenCode normally retries such failures, and a retry attempt is itself a new paid request: during peak pricing it must not reach the provider, and the work must not be lost when OpenCode's retry budget runs out.

`opencode-offpeak` registers OpenCode's supported `retry` hook. When a retryable failure happens while pricing is blocked and the plugin is ON in `auto` mode, the plugin vetoes the retry (`decision = { retry: false }`), so no retry attempt reaches the provider. The work is then marked to continue at the next allowed window:

- A queue-owned task moves to `WAITING_OFFPEAK` (not `FAILED`) and keeps its session ID; at the next off-peak transition the same session continues with the safe continuation prompt.
- A normal interactive session is recorded with minimal recovery metadata; at the next off-peak transition the same session receives the same safe continuation prompt. `/offpeak status` reports it as `Recovery: N session(s) waiting for off-peak`.

The continuation does not replay the failed provider request and does not create a new session or a duplicate prompt. Non-retryable failures (for example an invalid request) still end as `FAILED`/error, a retryable failure while pricing is already allowed keeps OpenCode's normal retry behavior, and OFF/`queue`/`guard` modes are unchanged. Interactive recovery metadata is persisted in OpenCode plugin storage, so a server reload or restart during peak keeps the pending continuation.

The OpenCode background server must be running for unattended work. It can remain active after the TUI or terminal closes:

```sh
opencode service start
opencode service status
```

After a machine restart, queue metadata remains in OpenCode's local plugin storage. Start the OpenCode background service again (or configure your OS service manager to start the supported `opencode serve` command) for automatic processing to resume. The plugin does not install a daemon or OS scheduler.

## Modes

Set `mode` in `~/.config/opencode/offpeak.json`:

- `auto` (default): start queued tasks off-peak, automatically resume a paused same-session task, defer normal interactive supported-model requests at the pre-model hook until off-peak returns, and stop retryable provider failures during peak so the same session continues at the next off-peak window.
- `queue`: start queued tasks off-peak; a task paused at peak waits for `/offpeak resume <task-id>` or `/offpeak run-now <task-id>`; interactive peak requests are blocked immediately by the transport guard.
- `guard`: enforce request pricing for interactive OpenCode sessions, but do not automatically start queued tasks or defer interactive requests for a later window.

All queue automation respects the persistent `enabled` setting. The guard itself does not turn OFF into a price bypass. A session you explicitly switched with `/offpeak session off` is the documented exception: that one interactive session may dispatch verified peak-priced work in any mode, and every other session and every task keeps the behavior above.

## Pricing policy

### Provider support matrix

| Provider | Time-based protection | Covered current model IDs |
|---|---|---|
| OpenCode Go (`opencode-go`) | Yes — peak-deferred | Peak-priced: `deepseek-v4.1-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`. Every other documented Go model is `FLAT` (one all-hours price; never waits). |
| Direct DeepSeek API (`deepseek`) | Yes — peak-deferred | `deepseek-flash`, `deepseek-v4-pro`, plus the legacy aliases `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp`, which the provider still accepts and bills at the Flash price. |
| OpenCode Zen (`opencode`) | No waiting required | No policy by design: Zen publishes one all-hours price per model with no peak/off-peak tiers, so requests are never delayed or blocked. |

Sources and verification dates are recorded on each policy (`source`, `verifiedAt`) and in `docs/pricing-policies.md`. The direct-DeepSeek policy ships as the second built-in policy ID, `deepseek-api`; both peak-priced providers share the same rule (peak Monday–Friday 01:00–04:00 and 06:00–10:00 UTC; off-peak everything else, including weekends and Chinese public holidays in full) and the same shared holiday calendar data.

Unknown or newly released model IDs under a peak-priced provider are **not guessed**: they evaluate `UNKNOWN` and fail closed with an actionable message until a verified policy update ships. There is deliberately no `deepseek-*` wildcard. OpenCode Zen has no policy at all, so a new Zen model is never blocked because a DeepSeek policy exists for another provider.

### The built-in policy IDs

`deepseek-opencode-go` (provider `opencode-go`) and `deepseek-api` (provider `deepseek`). Their canonical rules are:

- Peak: Monday–Friday 01:00–04:00 and 06:00–10:00 UTC.
- Off-peak: all other hours, weekends, and Chinese statutory public holidays in full.
- Weekend make-up working days stay off-peak: DeepSeek defines weekends as off-peak, so an adjusted Saturday or Sunday is never peak.

Holiday dates come from the official State Council calendar kept in `src/holidays.ts` (year, exception dates, source URL, verification date, description). The full-day off-peak exception overrides every weekday peak window, evaluated on the calendar's own time zone (`Asia/Shanghai`), so the host-local time zone never matters. Years without a holiday calendar keep the deterministic weekly schedule; no future dates are guessed. The holiday calendar requires one data update per year, published by the State Council the previous November.

The direct DeepSeek pricing documentation defines the exemption ("…excluding Chinese public holidays. All other hours are off-peak, including weekends and Chinese public holidays in full."), and the OpenCode Go pricing page documents the same weekly windows for this provider. The Go price table lists peak DeepSeek rates at twice their off-peak per-token rates, so equal token use consumes the allowance twice as fast during peak hours. Re-verify both pages annually; upstream [anomalyco/opencode#53071](https://github.com/anomalyco/opencode/issues/53071) tracks an open user report about National Day holiday billing and is the cue for a fresh check.

The Go peak model IDs are `deepseek-v4.1-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, and `deepseek-v4-flash-vision-exp` under provider ID `opencode-go`; the direct API peak model IDs are `deepseek-flash`, `deepseek-v4-pro`, and those same two legacy aliases under provider ID `deepseek`. Every other Go model documented in the pricing table has a single all-hours price and is declared as a flat model: it is never peak-priced, so it is never held or blocked. That list mirrors the provider's own table, because OpenCode names automatic session titles with the provider's small model — for `opencode-go` that is `gpt-6-luna` — and a title must not be blocked as an unknown model. A model that matches neither list under a configured provider fails closed; a provider with no policy is shown as `UNTRACKED` (with a verified explanation when the provider's pricing is known to be flat, as for OpenCode Zen); queued tasks require a matching policy. When a provider ships a new model: verify the official model ID, its current pricing, its peak schedule and holiday semantics, add or update the policy in `src/policy.ts`, add tests, and cut a patch release.

### Held-request feedback

When an interactive primary request is held for peak pricing, the TUI shows a non-chat toast — "Peak pricing active — request held until 08:00 Asia/Bangkok. It will resume automatically in this session." — and another when off-peak returns ("Off-peak pricing started. Resuming the held request in this session."). If the hold is released by `/offpeak session off` while pricing is still peak, the release toast says so explicitly ("Session off-peak protection is OFF. Releasing the held request in this session now."). The deadline is rendered in the configured `displayTimeZone`. These notifications travel on OpenCode's own event stream (`rpc.opencode-offpeak.hold` / `rpc.opencode-offpeak.resume`); they never enter the session or the model context, they are not repeated, a user cancel produces no false resumption, and auxiliary `title`/`compaction`/`generate` requests stay silent. Headless clients such as `opencode run` have no subscriber and remain silent.

Pricing details can change. This release verified the built-in schedules, the model lists, the Zen flat-pricing fact, and the 2026 holiday calendar against the [OpenCode Go pricing page](https://opencode.ai/docs/go/), the [OpenCode Zen pricing page](https://opencode.ai/docs/zen/), the [DeepSeek pricing documentation](https://api-docs.deepseek.com/quick_start/pricing), and the [State Council notice](https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html) on 2026-10-15. Review those sources before relying on a later policy update.

## Configuration

The plugin's local configuration file is:

```text
$OPENCODE_CONFIG_DIR/offpeak.json
```

If `OPENCODE_CONFIG_DIR` is unset, this is `$XDG_CONFIG_HOME/opencode/offpeak.json`, or `~/.config/opencode/offpeak.json` when `XDG_CONFIG_HOME` is unset. Set `OPENCODE_OFFPEAK_CONFIG` to use another path. The first `/offpeak on` or `/offpeak off` command creates the file atomically. Queue metadata and task/session IDs use OpenCode's persistent plugin storage.

Example:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "mode": "auto",
  "displayTimeZone": "Asia/Bangkok"
}
```

Omit `policies` to use the built-in DeepSeek/OpenCode Go policy. To define custom policies, provide the complete policy set; include the built-in policy too if you still want it. The file is the canonical setting for both commands and external configuration edits. Interactive toggle commands update `enabled` immediately. External edits are picked up by the running server's file watcher. The policy timezone controls price evaluation; `displayTimeZone` controls status output.

See [configuration](docs/configuration.md) and [pricing policies](docs/pricing-policies.md) for validation and custom policy details.

## Limitations and recovery

- A task cannot execute while the OpenCode server is stopped. It resumes when a server loads the plugin and queue state.
- OpenCode documents session crash recovery as at-least-once. If a task persisted as `RUNNING` when the server restarted, this plugin does not automatically replay it: it marks the task `FAILED`, preserves its session ID, and requires an explicit `/offpeak retry`. That is the safe choice when the provider may have received a paid request before the crash.
- A `WAITING_OFFPEAK` task is safe to resume automatically because the guard persisted that state before allowing another provider request. In `auto` mode it continues with the same session ID.
- A retryable provider failure during peak never retries into the provider. OpenCode's agent-loop request is retried with jittered exponential backoff; header-timeout failures are bounded by OpenCode to three retries (attempts 2–4, denied at attempt 5). The plugin observes every retry decision through the supported `retry` hook.
- The continuation prompt asks the model to continue from the current project state; the plugin does not replay the exact failed provider request. A transport failure can be ambiguous (the provider may have received the request before the error), which is why the continuation is a state-aware new turn instead of a byte-for-byte replay.
- A request deferred at the pre-model hook lives in the running OpenCode server process; a plugin/server shutdown fails it closed as blocked rather than sending it under an uncertain pricing state. A retryable provider failure during peak instead records minimal recovery metadata in OpenCode plugin storage, so the same session continues at the next off-peak window even across a reload.
- A session whose protection was explicitly switched off (`/offpeak session off`) keeps that override across reloads and restarts until it is switched back on or the session is deleted; while it is off, peak-priced dispatches in that session are real peak-rate inference and are billed accordingly.
- `/offpeak session on|off` needs a focused session; on the home screen it refuses rather than guessing which session was meant.
- If OpenCode's own location-activity sweep interrupts a deferred session (no durable session events for 60 minutes), the plugin records the same persisted recovery and the session continues at the next allowed window; user interrupts are never converted into recoveries.
- A session that never settles after a retryable failure (no outcome is recorded) is not continued automatically; its recovery record is dropped without sending anything rather than injecting a message into an unclear session.
- The plugin blocks at the provider request boundary. It does not roll back a request already accepted by a provider or interrupt an already-running local tool operation.
- The policy protects requests routed through OpenCode's v2 HTTP and experimental WebSocket model hooks. It does not control calls made by other programs.
- Model/provider API stability is limited to the documented OpenCode v2 range above.

## Privacy and security

There is no telemetry. The plugin does not send prompts, code, queue data, or usage data to a third party. Prompts and task state remain in local OpenCode storage; inference goes only to the provider configured in OpenCode. The config file is written with owner-only permissions when created. Do not put API credentials in the policy file.

Report security issues privately using GitHub's **Report a vulnerability** flow for this repository.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm pack --dry-run
```

Tests use a fake session driver and clock; they do not call paid providers. See [development](docs/development.md), [architecture](ARCHITECTURE.md), and [troubleshooting](docs/troubleshooting.md).

## Inspirations

This implementation was written independently against the OpenCode v2 API. It was informed by the problem space explored by [`opencode-queue`](https://github.com/geckom/opencode-queue), [`opencode-scheduler`](https://github.com/different-ai/opencode-scheduler), [`opencode-peak-guard`](https://github.com/jetsanix/opencode-peak-guard), and [`vv-opencode`](https://github.com/osovv/vv-opencode). No code was copied or forked from those projects.

## License

MIT. See [LICENSE](LICENSE).
