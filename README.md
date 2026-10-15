# opencode-offpeak

Queue OpenCode agent tasks, block paid model requests during expensive pricing windows, and resume the **same OpenCode session** when off-peak pricing returns.

`opencode-offpeak` is an OpenCode CLI v2 plugin. Its default policy covers DeepSeek models through OpenCode Go. Pricing is enforced at two lifecycle points: a pre-model deferral and the outbound transport guard. In `auto` mode, a supported request that reaches peak pricing waits at the pre-model hook — before OpenCode creates the provider attempt and its response-header timer — and the same session continues the same turn automatically when off-peak pricing returns, with zero provider traffic while pricing is blocked. The transport guard remains the final hard barrier immediately before OpenCode sends an HTTP request or an experimental WebSocket frame. If a request is already in flight and fails with a retryable provider/network error after peak pricing begins, the retry is stopped before it can reach the provider and the same session continues automatically at the next off-peak window.

> **Compatibility:** OpenCode CLI `>=2.0.26 <2.1.0`. This release targets the v2 plugin API shipped with OpenCode 2.0.26 and is validated against OpenCode 2.0.26 and 2.0.27 (the current official v2 release). The package declares the range in `engines.opencode` and both entrypoints refuse to initialize on an unsupported host with an actionable error instead of failing later at runtime. Later API versions are not claimed until CI and runtime checks cover them.

## Install

```sh
opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.6
```

This installs the released `v0.1.6` directly from its GitHub tag using [OpenCode v2's supported npm-compatible Git package syntax](https://opencode.ai/v2/docs/plugins). The release includes both server and TUI entrypoints. npm publication is optional future distribution; it is not required to install or use this release.

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
/offpeak pricing
/offpeak retry <task-id>
/offpeak resume <task-id>
/offpeak run-now <task-id>
```

- `/offpeak on` persists the enabled setting and resumes queue processing.
- `/offpeak off` persists the disabled setting and pauses automatic starts/resumes.
- `/offpeak status` shows the toggle, mode, model policy, price state, request decision, next transition, queue counts, held interactive requests, sessions waiting for off-peak recovery, active session, and any override.
- `/offpeak list` shows task IDs, states, stored session IDs, and the last failure.
- `/offpeak cancel <task-id>` cancels the task and preserves its session record.
- `/offpeak remove <task-id>` removes a terminal (`COMPLETED`, `FAILED`, or `CANCELLED`) task from the queue. Active tasks must be cancelled first; the OpenCode session is preserved.
- `/offpeak retry <task-id>` explicitly retries a failed task in its stored session.
- `/offpeak resume <task-id>` requests a waiting task's continuation in `queue` mode.
- `/offpeak run-now <task-id>` grants a visible, task-scoped 15-minute peak-price override. It requires the plugin to be ON and can consume OpenCode Go allowance at peak rates.

**Disabling the plugin pauses its automation. It does not mean “run everything regardless of price.”** Queue records and session IDs remain stored. The hard peak guard remains active while the plugin is OFF; OFF never creates an override and never releases a request that is already held at the boundary. A request held in `auto` mode resumes only after the plugin is ON again and pricing allows.

## What happens at a pricing boundary

In `auto` mode, a supported request that reaches peak pricing first waits at OpenCode's pre-model lifecycle hook (`model.request`), which runs while the model request is being prepared and before OpenCode creates the provider attempt and its response-header timeout. Nothing is sent to the provider while the request waits; the same session and the same request continue the same turn automatically at the policy's next off-peak transition — no second message, no duplicate prompt, no new session, and no synthetic continuation. `/offpeak status` reports held requests (`Interactive: N request(s) waiting for off-peak`). The hold lives in the OpenCode background server process and wakes on the scheduled pricing boundary, not on another message or command.

A queued `auto` task behaves the same way: if it reaches peak pricing before its next provider request, the guard stores `WAITING_OFFPEAK` and the same session waits and continues. Local filesystem and other tool operations already in flight are allowed to settle; the plugin does not kill them when the clock changes.

The HTTP and experimental WebSocket transport guard still runs immediately before OpenCode sends anything, as the final hard barrier. Requests that arrive while the plugin is OFF, or in `queue`/`guard` mode, are blocked by that guard exactly as before. If the plugin shuts down or the server restarts while a request is waiting, the request fails closed as blocked instead of being sent under an uncertain pricing state; the OpenCode server's own execution-claim recovery resumes sessions interrupted by a crash, and the plugin continues to enforce pricing when they come back.

If OpenCode itself interrupts a waiting session (its location-activity sweep ends a session that has had no durable events for 60 minutes), the plugin keeps the persisted deferral and continues the same session automatically at the next allowed window. A user cancel clears the pending deferral instead, so nothing continues after you cancel.

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

All queue automation respects the persistent `enabled` setting. The guard itself does not turn OFF into a price bypass.

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

When an interactive primary request is held for peak pricing, the TUI shows a non-chat toast — "Peak pricing active — request held until 08:00 Asia/Bangkok. It will resume automatically in this session." — and another when off-peak returns. The deadline is rendered in the configured `displayTimeZone`. These notifications travel on OpenCode's own event stream (`rpc.opencode-offpeak.hold` / `rpc.opencode-offpeak.resume`); they never enter the session or the model context, they are not repeated, a user cancel produces no false resumption, and auxiliary `title`/`compaction`/`generate` requests stay silent. Headless clients such as `opencode run` have no subscriber and remain silent.

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
