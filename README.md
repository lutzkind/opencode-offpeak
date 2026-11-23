# opencode-offpeak

Queue OpenCode agent tasks, block paid model requests during expensive pricing windows, and resume the **same OpenCode session** when off-peak pricing returns. OpenCode CLI/TUI and OpenCode Desktop have **independent** persistent protection defaults, so one client can run at peak while the other keeps waiting.

`opencode-offpeak` is an OpenCode v2 plugin with server, TUI, and Desktop GUI entrypoints. Its default policy covers DeepSeek models through OpenCode Go. Pricing is enforced at two lifecycle points: a pre-model deferral and the outbound transport guard. In `auto` mode, a supported request that reaches peak pricing waits at the pre-model hook — before OpenCode creates the provider attempt and its response-header timer — and the same session continues the same turn automatically when off-peak pricing returns, with zero provider traffic while pricing is blocked. The transport guard remains the final hard barrier immediately before OpenCode sends an HTTP request or an experimental WebSocket frame. If a request is already in flight and fails with a retryable provider/network error after peak pricing begins, the retry is stopped before it can reach the provider and the same session continues automatically at the next off-peak window. When one session must deliberately run through a peak window, `/offpeak protection chat off` authorizes verified peak-priced inference for that chat alone; every other chat stays protected. CLI and Desktop each have their own persistent global default, both ON, changed only by that interface with `/offpeak protection global on|off`.

> **Compatibility:** OpenCode CLI `>=2.0.26 <2.5.0`; the Desktop GUI entrypoint requires **OpenCode Desktop 2.3.0** (the first release with the GUI plugin SDK). This release targets the v2 plugin API shipped with OpenCode 2.0.26 and is validated against OpenCode 2.0.26 (the minimum), 2.0.27, 2.0.30, 2.1.3, 2.2.6, 2.3.0, 2.3.2, and the current **2.4.1** (the live host). OpenCode 2.1 changed the session/compaction payload schema (`providerState` → `native`) but not the plugin hooks this package uses. OpenCode 2.2 left the hooks, RPC channel, and TUI surfaces used here unchanged. OpenCode 2.3 adds plugin surfaces (session fork, model resolve, idle, artifacts, credentials, session instructions, event type filters, and a deprecated `generate` alias); every hook, RPC channel, storage call, and TUI surface this package uses keeps its 2.2 signature. OpenCode 2.3.1 enables background compaction by default (`compaction.background`, replacing the experimental flag) and adds a `codemode` variant to the idle-background type; foreground and background compaction summaries both prepare a `compaction` model request, so the pre-model hold and the transport guard cover them unchanged. OpenCode 2.3.2 changes only `experimental.generate` (video is server-only) and prompt caching, neither of which this package uses. OpenCode 2.4 adds background jobs, video generation, automations, GUI icon declarations, and composer delivery modes; the only TUI context addition is `job.list`, the model and transport request hooks are unchanged, and this plugin registers no renderer affected by the OpenTUI 0.9.4 requirement. The OpenTUI 0.7/0.8/0.9 renderable changes apply to custom renderables, which this plugin does not define. OpenCode 2.2.3 split managed-policy plugin control from `integration.use` into `plugin.use`; that affects operators who deny plugins, not this plugin's runtime contract. The package declares the range in `engines.opencode` and both entrypoints refuse to initialize on an unsupported host with a clear error instead of failing later at runtime.

## Install

```sh
opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.4.4
```

This installs the released `v0.4.4` directly from its GitHub tag using [OpenCode v2's supported npm-compatible Git package syntax](https://opencode.ai/v2/docs/plugins). The release includes server, TUI, and Desktop GUI entrypoints. npm publication is optional future distribution; it is not required to install or use this release.

Restart OpenCode after installation. The plugin defaults to enabled, uses the current system timezone for display, and enforces the built-in DeepSeek/OpenCode Go policy without extra setup.

### Desktop GUI installation

The Desktop GUI is loaded from **Desktop's own** `opencode.json(c)`, not from the remote server's configuration and not from `cli.json`. Installing the package only on the remote OpenCode server enforces pricing there, but it does not make the settings page appear in the Desktop app. To get the native Offpeak page:

1. Keep the server package installed on the OpenCode server that runs your sessions (the `opencode plugin add ...#v0.4.4` command above). That server remains the single authority for pricing, defaults, ownership, and enforcement.
2. List the same package in Desktop's global `opencode.json(c)` on the machine running Desktop:

   ```jsonc
   {
     "plugins": ["git+https://github.com/lutzkind/opencode-offpeak.git#v0.4.4"]
   }
   ```

3. Set `OPENCODE_SERVER_PASSWORD` on the remote server if it is protected, and add that server in Desktop with the same password. The GUI uses the selected session's actual server client for every RPC, never an assumed local sidecar.
4. Open **Settings > Offpeak**. The page has exactly two control levels. **Desktop Protection** is the persistent default for every Desktop chat on that server. **Protection for this chat** is the explicit chat-level switch: turning it off bypasses protection for that chat only and releases a request already waiting for off-peak, while turning it on restores the chat to following its relevant global default. The page follows the chat you were viewing; when more than one chat is open on the selected server it offers a **Chat** selector that shows the real OpenCode title, the project, and a shortened session ID. The full session ID is shown separately for troubleshooting. The page never changes CLI Protection.

The same `/offpeak` commands are available in Desktop chat through the native composer slash command: `/offpeak status`, `/offpeak protection global on|off`, and `/offpeak protection chat on|off`. The Desktop handler uses the shared Offpeak command implementation and its own Desktop global default.

The Desktop app must be 2.3.0 or newer. The package builds its GUI from `src/gui.tsx` into `dist/gui-experimental.cjs` through the official `@opencode/plugin/gui/vite` preset.

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
/offpeak protection global on
/offpeak protection global off
/offpeak protection chat on
/offpeak protection chat off
/offpeak session on
/offpeak session off
/offpeak client
/offpeak client cli on
/offpeak client cli off
/offpeak client desktop on
/offpeak client desktop off
/offpeak pricing
/offpeak retry <task-id>
/offpeak resume <task-id>
/offpeak run-now <task-id>
```

- `/offpeak on` persists the enabled setting and resumes queue processing.
- `/offpeak off` persists the disabled setting and pauses automatic starts/resumes.
- `/offpeak protection global on|off` changes only the global default of the interface that runs it. In the CLI it writes `client: "cli"`; in Desktop it writes `client: "desktop"`. The other interface's default is never modified by the command.
- `/offpeak protection chat off` disables off-peak protection for the current chat only: that chat's verified peak-priced requests run immediately, and any request it already has waiting for off-peak is released. `/offpeak protection chat on` removes the explicit override and restores the chat to following its relevant interface default. Neither form changes a global setting or another chat.
- `/offpeak status` shows both global defaults, the current chat's ownership and override source, the effective protection, the price state, the request decision, the next transition, queue counts, held interactive requests, and sessions waiting for off-peak recovery.
- `/offpeak session on|off` remains a supported alias for `/offpeak protection chat on|off`.
- `/offpeak client` shows the independent CLI and Desktop defaults, the current chat's ownership, and its effective protection (including whether it is an explicit override, a client default, or fail-closed).
- `/offpeak client cli on|off` and `/offpeak client desktop on|off` remain explicit per-client aliases over the same persisted defaults; each changes only the named client.
- `/offpeak list` shows task IDs, states, stored session IDs, and the last failure.
- `/offpeak cancel <task-id>` cancels the task and preserves its session record.
- `/offpeak remove <task-id>` removes a terminal (`COMPLETED`, `FAILED`, or `CANCELLED`) task from the queue. Active tasks must be cancelled first; the OpenCode session is preserved.
- `/offpeak retry <task-id>` explicitly retries a failed task in its stored session.
- `/offpeak resume <task-id>` requests a waiting task's continuation in `queue` mode.
- `/offpeak run-now <task-id>` grants a visible, task-scoped 15-minute peak-price override. It requires the plugin to be ON and can consume OpenCode Go allowance at peak rates.

**Disabling the plugin pauses its automation. It does not mean “run everything regardless of price.”** Queue records and session IDs remain stored. The hard peak guard remains active while the plugin is OFF; OFF never creates an override and never releases a request that is already held at the boundary. A request held in `auto` mode resumes only after the plugin is ON again and pricing allows. The single exception is an explicit per-chat grant made with `/offpeak protection chat off` (see below), which applies to that one interactive chat.

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

### Canonical pricing for other plugins (`pricing` RPC)

Another plugin may need to know whether a model is in a verified PEAK window
without copying this plugin's schedule or holiday calendar. The read-only
`pricing` RPC is the canonical answer:

```
rpc.opencode-offpeak.pricing { providerID, modelID }
  -> { state: "PEAK" | "OFF_PEAK" | "FLAT" | "UNTRACKED" | "UNKNOWN",
       allowed: boolean, policyID?, nextTransition?, reason? }
```

It evaluates the same configured policies and clock as the guard and has no side
effects: it never queues, holds, blocks, or sends a request. `opencode-free-first`
`v0.2.0` uses it for `freeUsageMode: "peak-only"`; an unavailable RPC or an
unrecognized state is treated as not-PEAK by the consumer. The method does not
create a second pricing engine or expose any mutable state.

### Chat-scoped off-peak protection (`/offpeak protection chat on|off`)

Sometimes one session should deliberately run through a peak window while every other session stays protected:

```text
/offpeak protection chat off  →  Protection for this chat: OFF (explicit override)
                                   Effective protection: OFF
/offpeak protection chat on   →  Protection for this chat: follows the interface global
                                   Effective protection: ON (when that global is ON)
```

- **Current session only.** The command applies to the interactive session you are in. The session is resolved from OpenCode's supported TUI command context (the focused route, then the active session tab); you never copy a session ID. Run the command from an open session — on the home screen, with no session focused, it refuses with a clear message. `/offpeak protection chat off` never affects another chat, never affects background queue tasks, and never disables the plugin globally.
- **Default follows the interface.** A chat without an override follows the global default of its owning interface (CLI or Desktop). Only explicit off overrides are stored; there is no way to accidentally inherit one.
- **Persistent until changed.** The override is stored in OpenCode plugin storage and survives TUI restarts, plugin reloads, and full server restarts. There is no timer, no expiry, and no duration syntax. `/offpeak protection chat on` ends it immediately (the legacy `/offpeak session on` alias does the same). When the session is deleted (OpenCode's supported `session.deleted` event), the override is reaped; stale entries for sessions that no longer exist are also cleaned lazily when state is read.
- **Verified PEAK only.** With protection off, a request that evaluates `PEAK` under a verified policy is allowed immediately — primary, compaction, title, and generate requests alike, because they all belong to the session you authorized. `UNKNOWN` models and invalid configuration still fail closed. `OFF_PEAK`, `FLAT`, and `UNTRACKED` behave exactly as before.
- **Waiting work wakes immediately.** If the chat already has a request held for off-peak, `/offpeak protection chat off` releases it through the existing engine signal: the same request continues in the same session with no `continue` prompt, no re-sent message, no duplicate provider call, and no polling loop. The TUI shows "Session off-peak protection is OFF. Releasing the held request in this session now." Pending recoveries for that session (a deferred primary, a retry-failure continuation, a pending title, or a pending compaction) also proceed immediately, still in their native order.
- **Already-settled work is never recalled.** A committed dispatch (the allowed window already arrived) or a cancelled/refused hold is unaffected: switching protection off cannot resurrect it, and switching it on never interrupts a running provider request. The next request that crosses the guard during peak waits normally again.
- **Cancellation semantics are preserved.** A hold cancelled through `cancelHold` stays refused regardless of later protection changes.
- **Queue tasks stay separate.** A background queue task never inherits a session override, even when it runs in the same OpenCode session; `/offpeak run-now <task-id>` remains the task-scoped authorization.
- **Global precedence.** `/offpeak protection chat off` is an explicit, chat-scoped authorization, newer and more specific than the global automation state: in `auto`, `queue`, and `guard` modes, and even while the plugin is globally OFF, it lets that one session dispatch verified peak-priced work. Everything else stays untouched by the global state: OFF still pauses every queue start and auto-resume, still blocks every session that was not explicitly switched off, still blocks every task, and still never releases a held request by itself.
- **Status output.** `/offpeak status` reports the current chat's protection, and while peak pricing is active with protection off it makes the effective behavior explicit — `Pricing: PEAK`, `Protection for this chat: OFF (explicit override)`, `Requests: ALLOWED (chat override)`. Pricing is never reported as off-peak when it is peak.
- **Compaction.** With protection off, a manual or automatic compaction during peak runs immediately and leaves no pending-compaction marker; with protection on, the compact-first behavior documented above is unchanged.

### Independent CLI and Desktop protection (`/offpeak protection global`)

CLI/TUI and Desktop are separate clients of the same OpenCode server. Each has a persistent default, both start **ON**, and changing one never writes the other:

```text
/offpeak status                  →  CLI global protection: ON
                                    Desktop global protection: OFF
                                    Client ownership: cli
                                    Effective protection: ON
/offpeak protection global off   →  CLI global protection: OFF (Desktop unchanged)
/offpeak protection global on    →  CLI global protection: ON  (Desktop unchanged)

In Desktop chat:
/offpeak protection global off   →  Desktop global protection: OFF (CLI unchanged)
/offpeak protection chat off     →  Protection for this chat: OFF (only this chat)
```

- **Precedence is explicit.** Invalid configuration and `UNKNOWN` pricing always fail closed. An existing explicit `/offpeak protection chat off` still wins for that one chat. Otherwise a session reliably registered by exactly one client uses that client's default. An unregistered session, or one observed by both clients, stays protected.
- **Identification is client-side and supported.** The server's `model.request` hook has no client identity, and this plugin never guesses from IP addresses, User-Agent strings, undocumented internals, or environment variables. The TUI extension registers its routed session through the connected server's typed RPC as soon as the session appears (and again before every `/offpeak` command); the Desktop GUI does the same with the selected session's actual `SessionRef.server.client`. Registration is idempotent and targets the server that owns the session, including a remote server.
- **Shared sessions fail closed.** If both clients register the same session, it is stored as `ambiguous`; it remains protected even when one client's default is OFF. The last client to open the session never inherits ownership. The Desktop settings page reports the shared state. This also means a session first used in Desktop and later opened in the CLI stays shared until it is deleted; there is deliberately no heartbeat or lease that could let a stale observation expire.
- **First-request safety.** A session that has not yet been registered is `UNKNOWN` and protected. On a brand-new Desktop draft, OpenCode does not expose a supported pre-submit hook, so the GUI cannot register the session before the draft becomes a session; if that very first request reaches verified peak pricing in the few milliseconds before registration lands, it is held (never sent unprotected) and is released immediately once the Desktop registration arrives and the Desktop default is OFF. Off-peak requests are unaffected. Headless `opencode run` sessions have no TUI/GUI extension, so they remain unknown and protected.
- **One global document across locations.** OpenCode can load the plugin for several project directories in one server process. Writes read the latest stored client document and change only the intended field/session, so a stale location cannot revert another location's setting; each protection decision refreshes the document first. A storage read error fails closed to both defaults ON and refuses writes.
- **Existing installations migrate safely.** Both defaults initialize to ON when no client document exists, so every previously protected session keeps exactly its old behavior. The state is a minimal versioned document (`opencode-offpeak/clients-v1`) with `defaults` and per-session ownership; it survives plugin reloads and server restarts. OpenCode's supported `session.deleted` event removes ownership, and bounded lazy cleanup reaps state only for sessions that are confidently gone.
- **Queue tasks stay separate.** A queue-owned session never inherits a client default; `/offpeak run-now <task-id>` remains its task-scoped authorization. `/offpeak on|off` remains global automation and is not a client setting.
- **Status output.** `/offpeak status` adds `CLI global protection`, `Desktop global protection`, `Client ownership`, `Protection for this chat`, `Session protection (explicit)`, and `Effective protection` lines, so a global default is never confused with an explicit chat override.
- **Per-chat control exists in both clients.** `/offpeak protection chat on|off` in the TUI and **Protection for this chat** in Desktop write the same `session-overrides-v1` entry through the server that owns the chat. Either one applies to that chat only, releases a request already waiting for off-peak, and leaves both global defaults unchanged. The Desktop switch is checked when protection is effective and its description shows whether the chat follows a global default or has an explicit bypass.

The Desktop settings page exposes Desktop Protection, the read-only CLI Protection value, the actual chat title/project/shortened ID, ownership, effective protection, and Protection for this chat. It writes only `client: "desktop"` and the chat override through that server's typed RPC, so it can never change CLI Protection.

### Desktop chat titles and commands

The Desktop chat list resolves the canonical OpenCode session title from the app's synced session store, then the project/repository name, then a shortened session ID. The full session ID remains visible under **Session ID** for troubleshooting. OpenCode rename events update the displayed title; a session that is not yet in the synced store is loaded once through the supported session API. A genuinely untitled session shows **Untitled session** rather than an invented name. No separate title database or polling loop exists.

Desktop composer slash commands are registered through the installed GUI SDK's supported `Command.slash` field. They call the same shared command implementation as the CLI and use the Desktop global default; they are not a second command or protection system.

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

All queue automation respects the persistent `enabled` setting. The guard itself does not turn OFF into a price bypass. A chat you explicitly switched with `/offpeak protection chat off` is the documented exception: that one interactive chat may dispatch verified peak-priced work in any mode, and every other chat and every task keeps the behavior above.

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

When an interactive primary request is held for peak pricing, the TUI shows a non-chat toast — "Peak pricing active — request held until 08:00 Asia/Bangkok. It will resume automatically in this session." — and another when off-peak returns ("Off-peak pricing started. Resuming the held request in this session."). If the hold is released by `/offpeak protection chat off` while pricing is still peak, the release toast says so explicitly ("Session off-peak protection is OFF. Releasing the held request in this session now." in the TUI, or "Protection is OFF for this chat. Releasing the held request now." in Desktop). The deadline is rendered in the configured `displayTimeZone`. These notifications travel on OpenCode's own event stream (`rpc.opencode-offpeak.hold` / `rpc.opencode-offpeak.resume`); they never enter the session or the model context, they are not repeated, a user cancel produces no false resumption, and auxiliary `title`/`compaction`/`generate` requests stay silent. Headless clients such as `opencode run` have no subscriber and remain silent.

Pricing details can change. This release verified the built-in schedules, the model lists, the Zen flat-pricing fact, and the 2026 holiday calendar against the [OpenCode Go pricing page](https://opencode.ai/docs/go/), the [OpenCode Zen pricing page](https://opencode.ai/docs/zen/), the [DeepSeek pricing documentation](https://api-docs.deepseek.com/quick_start/pricing), and the [State Council notice](https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html) on 2026-10-15. Review those sources before relying on a later policy update.

## Configuration

The plugin's local configuration file is:

```text
$OPENCODE_CONFIG_DIR/offpeak.json
```

If `OPENCODE_CONFIG_DIR` is unset, this is `$XDG_CONFIG_HOME/opencode/offpeak.json`, or `~/.config/opencode/offpeak.json` when `XDG_CONFIG_HOME` is unset. Set `OPENCODE_OFFPEAK_CONFIG` to use another path. The first `/offpeak on` or `/offpeak off` command creates the file atomically. Queue metadata, task/session IDs, explicit chat overrides, and global defaults/ownership use OpenCode's persistent plugin storage.

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
- A chat whose protection was explicitly switched off (`/offpeak protection chat off`) keeps that override across reloads and restarts until it is switched back on or the session is deleted; while it is off, peak-priced dispatches in that chat are real peak-rate inference and are billed accordingly.
- `/offpeak protection chat on|off` (and the `/offpeak session on|off` alias) needs a focused chat; on the home screen it refuses rather than guessing which session was meant.
- `/offpeak protection global on|off` needs no focused chat and changes only that interface. `/offpeak status` and `/offpeak client` need no focused chat for the defaults, but the per-chat ownership/effective lines require one.
- Client ownership is a two-client distinction. Two CLI instances, or two Desktop windows, are the same client; a session opened in both CLI and Desktop is shared and stays protected. There is no automatic lease expiry, so a session used once from each client remains ambiguous until it is deleted.
- The Desktop GUI requires Desktop 2.3.0+ and its own `opencode.json(c)` entry. Installing the server package on the remote server alone does not deploy the local GUI entrypoint. Desktop slash commands and title resolution use the 2.4.1 GUI API validated by this release.
- Disabling a global or chat protection setting releases only interactive holds that are still waiting. Queue-owned tasks never inherit either setting; they keep their existing queue state and task-scoped `/offpeak run-now` authorization.
- Headless `opencode run` has no TUI/GUI registration path and is therefore `UNKNOWN` (protected at peak). Use `/offpeak protection chat off` from an interactive session, or run at off-peak, when headless peak inference is intended.
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
