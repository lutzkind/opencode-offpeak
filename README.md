# opencode-offpeak

Queue OpenCode agent tasks, block paid model requests during expensive pricing windows, and resume the **same OpenCode session** when off-peak pricing returns.

`opencode-offpeak` is an OpenCode CLI v2 plugin. Its default policy covers DeepSeek models through OpenCode Go. The request guard runs at OpenCode's outbound model transport boundary; a task that reaches peak pricing pauses before its next provider request and keeps its session and project context. In `auto` mode the same hold applies to normal interactive messages: a supported request sent during peak pricing stays pending at the boundary and proceeds automatically when off-peak pricing returns, so you do not need to resend it.

> **Compatibility:** OpenCode CLI `>=2.0.26 <2.1.0`. This release targets the v2 plugin API shipped with OpenCode 2.0.26. The package declares the range in `engines.opencode` and both entrypoints refuse to initialize on an unsupported host with an actionable error instead of failing later at runtime. Later API versions are not claimed until CI and runtime checks cover them.

## Install

```sh
opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.2
```

This installs the released `v0.1.2` directly from its GitHub tag using [OpenCode v2's supported npm-compatible Git package syntax](https://opencode.ai/v2/docs/plugins). The release includes both server and TUI entrypoints. npm publication is optional future distribution; it is not required to install or use this release.

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
- `/offpeak status` shows the toggle, mode, model policy, price state, request decision, next transition, queue counts, held interactive requests, active session, and any override.
- `/offpeak list` shows task IDs, states, stored session IDs, and the last failure.
- `/offpeak cancel <task-id>` cancels the task and preserves its session record.
- `/offpeak remove <task-id>` removes a terminal (`COMPLETED`, `FAILED`, or `CANCELLED`) task from the queue. Active tasks must be cancelled first; the OpenCode session is preserved.
- `/offpeak retry <task-id>` explicitly retries a failed task in its stored session.
- `/offpeak resume <task-id>` requests a waiting task's continuation in `queue` mode.
- `/offpeak run-now <task-id>` grants a visible, task-scoped 15-minute peak-price override. It requires the plugin to be ON and can consume OpenCode Go allowance at peak rates.

**Disabling the plugin pauses its automation. It does not mean “run everything regardless of price.”** Queue records and session IDs remain stored. The hard peak guard remains active while the plugin is OFF; OFF never creates an override and never releases a request that is already held at the boundary. A request held in `auto` mode resumes only after the plugin is ON again and pricing allows.

## What happens at a pricing boundary

The guard checks the provider and model immediately before OpenCode sends an HTTP request or an experimental WebSocket frame. If a queued `auto` task is in a blocked window, the guard stores `WAITING_OFFPEAK` and holds that same session at the request boundary. Local filesystem and other tool operations already in flight are allowed to settle; the plugin does not kill them when the clock changes. The next inference request waits until pricing is allowed and the plugin is ON again.

In `auto` mode, a normal interactive request for a supported model is held the same way. The request you already sent stays pending — no new session, no duplicate prompt, and no second `continue` — and the same OpenCode session proceeds automatically at the policy's next off-peak transition. `/offpeak status` reports held interactive requests while they wait. The hold lives in the OpenCode background server process and wakes on the scheduled pricing boundary, not on another message or command. If the plugin shuts down or the server restarts while a request is held, the request fails closed as blocked instead of being sent under an uncertain pricing state; resend it after the server is back. Requests that arrive while the plugin is OFF, or in `queue`/`guard` mode, are blocked immediately.

The OpenCode background server must be running for unattended work. It can remain active after the TUI or terminal closes:

```sh
opencode service start
opencode service status
```

After a machine restart, queue metadata remains in OpenCode's local plugin storage. Start the OpenCode background service again (or configure your OS service manager to start the supported `opencode serve` command) for automatic processing to resume. The plugin does not install a daemon or OS scheduler.

## Modes

Set `mode` in `~/.config/opencode/offpeak.json`:

- `auto` (default): start queued tasks off-peak, automatically resume a paused same-session task, and hold normal interactive supported-model requests at the pricing boundary until off-peak returns.
- `queue`: start queued tasks off-peak; a task paused at peak waits for `/offpeak resume <task-id>` or `/offpeak run-now <task-id>`; interactive peak requests are blocked immediately.
- `guard`: enforce request pricing for interactive OpenCode sessions, but do not automatically start queued tasks or hold interactive requests for a later window.

All queue automation respects the persistent `enabled` setting. The guard itself does not turn OFF into a price bypass.

## Pricing policy

The built-in policy ID is `deepseek-opencode-go`. OpenCode Go currently lists peak hours as 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday; all other hours, including weekends, are off-peak. Its current Go price table lists peak DeepSeek rates at twice their off-peak per-token rates. Since Go limits are denominated in dollars, equal token use therefore consumes the allowance twice as fast during peak hours; that allowance effect follows from the published rate and limit tables. The policy follows the OpenCode Go schedule, not the separate DeepSeek API holiday wording.

The built-in model IDs are `deepseek-v4.1-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, and `deepseek-v4-flash-vision-exp` under provider ID `opencode-go`. An unrecognized model under a configured provider fails closed. A provider with no policy is shown as `UNTRACKED`; queued tasks require a matching policy.

Pricing details can change. This release verified the built-in schedule against the [OpenCode Go pricing page](https://opencode.ai/docs/go/) on 2026-10-09. Review that source before relying on a later policy update.

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
- An interactive request held in `auto` mode is not persisted: it lives in the running OpenCode server process. A plugin or server shutdown fails it closed as blocked rather than replaying it.
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
