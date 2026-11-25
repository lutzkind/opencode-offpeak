# Decisions

## 2026-11-25: Protection is two client globals plus one per-chat choice (v0.5.0)

The v0.4.x surface had accumulated an installation-wide `enabled` toggle, three
execution modes (`auto`, `queue`, `guard`), a persistent task queue with seven
commands, a first-client-wins ownership model with an `ambiguous` fail-closed
state, and a Desktop page with ownership, session IDs, chat pickers, and command
references. The user asked for the product they actually use: a CLI switch, a
Desktop switch, and a way to turn one chat on while its global is off.

Decision: remove the enable toggle, modes, and queue; keep exactly two
persistent client globals and one per-chat tri-state (`follow global`, `always
protect`, `allow peak`). An explicit chat setting wins over either global in
both directions. A chat with no explicit setting follows the client that most
recently opened it; an unregistered chat stays protected. The Desktop page
exposes only the two globals and the chat selector, and both globals are
writable there. `/offpeak on|off` now changes the calling client's global; the
old "OFF still blocks" behavior was the main source of confusion.

Rejected alternatives:

- Keeping the queue behind hidden commands. It would preserve dead storage,
  tests, and scheduler paths that nothing can reach, and the product statement
  is "just protection".
- Keeping first-client-wins ownership and requiring an explicit chat override
  to escape `ambiguous`. That reproduced the Desktop symptom: a Desktop global
  switch appeared to do nothing because the chat had once been seen by the CLI.
  Last-opener ownership matches the client the user is actually using, and an
  explicit chat setting still overrides it.
- Storing the globals in `offpeak.json`. They are per-installation client state,
  not pricing policy, and OpenCode plugin storage already provides the atomic
  read-merge-write needed by multiple locations.

Legacy config `enabled`/`mode` fields, `"off"` chat overrides, and the old
`ambiguous` ownership entries are accepted and migrated without an edit. The
legacy queue document is left untouched but is no longer read or executed.

## 2026-11-23: OpenCode 2.4.1 validation (v0.4.4)

OpenCode **2.4.1** was published at 15:57Z, after the 2.4.0 compatibility work
had started. The declared range `>=2.0.26 <2.5.0` already admitted the patch,
so the question was whether 2.4.1 changed a surface this plugin relies on.

The `@opencode/plugin` 2.4.0 → 2.4.1 diff touches three files: the Effect and
Promise plugin contexts add `experimental.automation.{create,list,delete}`, the
Promise adapter wires those endpoints, and the OpenTUI peer floor returns to
0.8.0. `model.request`, `http.request`, the experimental WebSocket hooks,
`retry`, session events, storage, RPC, and the TUI/GUI surfaces used here keep
their 2.4.0 signatures. No runtime code change is required.

Decision: keep the range, raise the build dependency to `@opencode/plugin@2.4.1`,
run the complete suite on the real 2.4.1 CLI/TUI, and ship the validation as
`v0.4.4`. Rejected alternatives: silently treating 2.4.1 as covered by the
2.4.0 release (the range allows it, but the release notes would overstate what
was tested) and widening beyond `<2.5.0` (nothing in 2.5 exists to test).

## 2026-11-23: Re-check a refused hold after guard awaits

A macOS CI run exposed a narrow race in the hold loop. `cancelHold` marks a
parked request `refused` synchronously, but the loop could already be awaiting
`config.read()`. If the user's protection-off wake-up arrived before that read
settled, the loop continued into the override commit path and overwrote the
refused state with `committed`, resurrecting a request the caller had cancelled.

Decision: re-check the refused state after the in-loop config read and before
any commit, arming the transport refusal exactly once. The initial check stays.
This preserves the existing invariant without a second state machine, timer,
lock, or task adoption. A deterministic test gates the in-loop read, cancels
the hold, switches protection off, then releases the read and proves one
consumable refusal and zero provider prompts. This is a correctness fix only;
pricing policy, queue semantics, and storage are unchanged.

## 2026-11-23: OpenCode 2.4.0 compatibility (v0.4.3)

OpenCode **2.4.0** was published on 2026-11-23T09:22Z. The live Desktop SSH
server started 2.4.0 and the plugin was pinned at `v0.4.2`, whose verified
range ended at `<2.4.0`; the server logged the guard error and unloaded the
plugin, so no peak-price protection existed on that host. As with the previous
ceiling failures (`<2.1.0`, `<2.2.0`, `<2.3.0`), the failure was the guard, not
a removed runtime contract.

The published `@opencode/plugin` 2.4.0 declarations were compared with 2.3.2.
`model.request`, `http.request`, the experimental WebSocket hooks, `retry`,
session events, storage, RPC, `context.app.version`, and the TUI context used
by this plugin keep their signatures. The differences are additive:
`session.job.list`, video generation (including a `video` idle-background
variant), tool `execute` metadata/codemode fields, OAuth `revoke`, GUI icon
declarations, a `browser.experimental` open/close handle, composer `send` and
`delivery`, and an OpenTUI `>=0.9.4` peer floor. The plugin defines no custom
renderable or code-block renderer, so the renderer callback change does not
apply. OpenCode 2.4 also restores asynchronous plugin loading; a first request
can arrive before the server plugin's RPC registration, which the existing
fail-closed `UNKNOWN`/protected rule already covers once the plugin is loaded,
and the TUI re-registers on the next route change or command.

Decision: raise the verified range to `>=2.0.26 <2.5.0` only after the packed
plugin loads in the real 2.4.0 TUI, `/offpeak status` works, the deterministic
and real fixture suites pass, and a protected request still produces zero
provider requests before the boundary and exactly one at it. Raise the build
dependency to `@opencode/plugin@2.4.0`. Rejected alternatives: dropping the
ceiling (the documented policy is an explicit verified ceiling widened per
release), treating 2.4.0 as a warning-only host (fails open on a contract that
was not tested), and changing runtime code without a demonstrated need.

## 2026-11-23: One global client document across per-location plugin engines

Live verification showed Desktop Protection reverting to OFF after CLI sessions loaded in a different directory. OpenCode can load the server plugin once per project/location in the same process; each engine had its own in-memory snapshot of the shared `clients-v1` document. A stale location then persisted its old defaults while registering a session.

Decision: keep one global document and make every writer a read-merge-write under a process-wide mutex, applying only the changed default field or one session ownership entry. Every protection decision, `clientStatus`, and `status` refreshes the stored document before evaluating authorization. A failed read resets to the safe ON defaults, clears ownership, and refuses writes; it never infers a bypass. Rejected alternatives: a second service or database (violates the one-package boundary), a heartbeat/lease (cannot guarantee correctness), and per-location documents (the settings are explicitly global). This changes no storage schema and no pricing policy.

## 2026-11-23: Interface-scoped protection commands, native Desktop slash commands, and canonical chat titles

The v0.3.x client defaults already persisted independently, but the command names (`client`, `session`) did not express which level the user was changing, and the Desktop page exposed the override as an inverted "allow peak" switch. The requested model is two controls per interface: a global default and a chat-level bypass. The implementation keeps the existing `clients-v1` and `session-overrides-v1` documents and adds no database, queue, scheduler, service, or policy engine.

Canonical commands are `/offpeak protection global on|off` and `/offpeak protection chat on|off`. The command module passes the calling surface (`cli` or `desktop`); a global command therefore writes only that interface's field and cannot modify the other interface. `chat on` removes the session override so the chat follows its relevant global default; it does not invent an explicit ON override, so a global OFF remains effective. The old `/offpeak client` and `/offpeak session` forms remain aliases over the same state for compatibility with v0.3.x users and tests.

Desktop slash commands use the installed `@opencode/plugin@2.3.2` `Command.slash` field, the officially supported composer slash registration. The same `src/commands.ts` parser/executor is shared by the TUI and GUI; the GUI supplies the Desktop surface and the routed session identity. No UI injection, synthetic key handling, or duplicate command handler was added. The GUI also subscribes to the existing `rpc.opencode-offpeak.hold`/`resume` events (typed as `${"rpc."}${string}` in the installed client) for the same non-chat feedback the TUI provides.

The Desktop chat list previously showed raw session IDs because `SessionRef` carries only `id`, `key`, `server`, and location. The actual title and project ID live in the server's canonical synced `data` store. The page reads `server.data.session.get(id).title` and `server.data.project.get(projectID)` reactively, syncs a session once through the supported session API when it is missing from that store, and falls back to **Untitled session** plus a shortened ID. Renames are handled by OpenCode's own `session.renamed` store update. No separate title database, poll, or repeated per-session fetch was introduced.

Queue semantics are unchanged and now explicitly tested: global and chat changes wake existing interactive holds through the existing signal/pump, while queue-owned tasks never inherit either setting. A queue task keeps its record, state, order, and task-scoped `/offpeak run-now` authorization; it is never adopted, restarted, duplicated, or dropped by a protection change. Client-setting load/write errors continue to fail closed and refuse writes.

## 2026-11-18: OpenCode 2.3.2 validation and background-compaction coverage

The live host moved from OpenCode 2.3.0 to **2.3.2** (2.3.1 and 2.3.2 were published on 2026-11-18). Both versions are already inside the declared range `>=2.0.26 <2.4.0`, so no range change is involved; the question is whether any behavior this plugin relies on changed.

The published `@opencode/plugin` declarations differ from 2.3.0 to 2.3.2 in only two places: `experimental.generate` loses `video` (server-only), and `SessionIdleBackground` gains a `codemode` variant. This package calls neither. `model.request`, `http.request`, the experimental WebSocket hooks, `retry`, session events, storage, RPC, and the TUI context keep their signatures.

OpenCode 2.3.1 enables **background compaction by default** (`compaction.background`, replacing `experimental.background_compaction`). That is the one new behavior that touches a request kind this plugin guards. Source inspection of `SessionCompaction` at v2.3.2 shows that both the foreground and the background summary prepare their model call through `SessionModelRequest.compaction`, whose scope `kind` is `"compaction"`; therefore the pre-model hold and the outbound transport guard cover a background summary exactly like a foreground compaction, and no plugin code reads or needs to read OpenCode's compaction settings. A real OpenCode 2.3.2 fixture test now proves a compact request at peak produces zero provider requests and exactly one at the boundary.

Decision: keep the runtime code unchanged, raise the build dependency to `@opencode/plugin@2.3.2`, validate the real compaction path on 2.3.2, and ship it as `v0.3.1`. Rejected alternatives: reading `compaction.background` (the plugin must not depend on OpenCode's internal scheduling), disabling background compaction for the user (a host behavior change outside the plugin's authority), and widening the version range (nothing in 2.4 exists to test).

## 2026-11-17: Independent CLI and Desktop defaults with fail-closed client ownership

CLI/TUI and Desktop connect to the same OpenCode server, and the user needs independent persistent protection defaults. The server remains the only pricing authority. A new minimal plugin-storage document (`opencode-offpeak/clients-v1`) stores `defaults.cli`, `defaults.desktop` (both initially `"on"`) and per-session observations. Changing one default writes only that field.

There is no supported client identity in `model.request`, `http.request`, the WebSocket hooks, or any server request context. The alternatives were rejected: IP/User-Agent/environment guesses are unreliable; a server-side `session.created` guess would attribute every session to whichever client happened to be running; a new authentication service or daemon would violate the one-package/one-engine boundary. The implemented mechanism is supported client-side registration through typed RPC: the TUI registers the routed session with its connected server, and the GUI registers the routed session with `SessionRef.server.client`. Registration is additive, idempotent, and never last-writer-wins: a second client makes the session `ambiguous`, which stays protected. An unregistered session is `UNKNOWN` and protected. The explicit `/offpeak session off` override retains precedence. Queue-owned sessions never inherit a client default.

The API gap is honest and bounded: Desktop has no pre-submit hook on a brand-new draft, so its first peak request can race the GUI's registration. The server fails closed for that unknown session and holds the request until registration arrives; it never sends an unprotected peak request. Headless `opencode run` has no client extension and remains `UNKNOWN`. This is documented rather than hidden behind an unreliable heuristic. No polling loop, heartbeat, lease, second database, queue, scheduler, or service was added.

`@opencode/plugin` is raised from `2.0.26` to `2.3.0` because the GUI SDK and Vite preset exist only from 2.3.0. The declared runtime range stays `>=2.0.26 <2.4.0`; the server/TUI surfaces used are unchanged, and the packed plugin is still smoke-tested on the minimum host. The GUI entrypoint is one prebuilt `dist/gui-experimental.cjs` from the official `@opencode/plugin/gui/vite` preset, exported as `./gui-experimental`.

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

## 2026-10-14: Peak deferral happens at the pre-model hook, not the transport boundary

OpenCode 2.0.27 begins an attempt's response-header timeout (default 300s) at attempt start, before the `http.request` hook chain completes; the v0.1.2–v0.1.3 interactive hold therefore could not outlast the timeout and surfaced `Timed out waiting for response headers` during peak. The deferral now runs at the supported `model.request` hook, which fires while the model request is prepared and before the provider attempt exists. In `auto` mode a peak request waits there and the same session continues the same turn at the boundary; the transport guard stays in place as the final hard barrier and `queue`/`guard`/OFF behavior is unchanged. The retry-hook recovery remains for requests that started off-peak and failed after crossing into peak. Because OpenCode's location-activity sweep can interrupt a session that has had no durable events for 60 minutes, the plugin also listens for `session.execution.interrupted` with reason `inactivity` and converts that specific interruption into the existing persisted recovery; user and shutdown interrupts are left untouched. No new runtime, scheduler, database, daemon, or polling loop is added.

## 2026-10-14: Chinese public holidays are full-day OFF_PEAK in the built-in policy

The DeepSeek pricing documentation defines the peak windows and the exemption: "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays. All other hours are off-peak, including weekends and Chinese public holidays in full." The OpenCode Go pricing page documents the same weekly windows for this provider and links to the DeepSeek page for the definition, and this pass was explicitly instructed to implement the confirmed holiday rule as part of the canonical policy. The policy model therefore supports explicit full-day OFF_PEAK exception calendars (`holidays`) that override every weekday peak window, and the built-in policy carries the 2026 China calendar from the State Council notice (国办发明电〔2025〕7号, published 2025-11-04) in `src/holidays.ts` with year, dates, source URL, verification date, and description. Holiday dates are evaluated on the calendar's own time zone (`Asia/Shanghai`), independent of the host and the policy display time zone. Adjusted weekend make-up workdays stay OFF_PEAK because weekends are always off-peak. `nextTransition` scans up to 14 days so long holiday runs cannot hide the next real transition, and a year without a calendar keeps the deterministic weekly schedule rather than guessing. Annual maintenance is required: the State Council publishes the next year's arrangement each November. Upstream [anomalyco/opencode#53071](https://github.com/anomalyco/opencode/issues/53071) (open, no vendor reply) reports peak-rate billing for Go during the 2026 National Day holiday; the October 1–7 Go billing comparison is not exposed per request (the provider offers only aggregate usage percentages), so that report is the cue for the annual re-check rather than a blocker for this confirmed rule.

A stored `policies` array that is an unmodified copy of the built-in policy (same id, providers, models, time zone, multiplier, and weekly windows) adopts the built-in holiday calendar *and the built-in flat model list* when the config is read. Existing installations commonly persist such a copy after their first `/offpeak on|off`, so they gain yearly holiday updates and the flat model list without editing the file, while any customized policy — including an explicit `holidays` or `flatModels` list — is preserved exactly.

## 2026-10-15: Direct DeepSeek API is a second built-in policy; Zen stays policy-free

OpenCode's live 2.0.27 registry exposes the direct DeepSeek API as provider `deepseek` (`@opencode/ai/providers/deepseek`, `https://api.deepseek.com`) with exactly two models, `deepseek-flash` and `deepseek-v4-pro`. DeepSeek's own pricing page documents the same weekly peak windows and holiday exclusion as the Go gateway, plus the legacy aliases `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp`, which are still accepted and billed at the Flash price. The plugin therefore ships a second built-in policy, `deepseek-api`, with an explicit four-ID list (no `deepseek-*` wildcard), reusing the shared weekly-window constant and the shared Chinese holiday calendar data rather than duplicating schedule or holiday logic. A future direct model fails closed with an actionable message until it is verified. A stored configuration that consists only of unmodified copies of the shipped policies adopts newly shipped built-in policies at read time, which is how an existing installation gains the direct policy without editing `offpeak.json`; any customization makes the stored set authoritative.

OpenCode Zen (provider `opencode`) is deliberately different: its pricing page lists one all-hours price per model with no peak/off-peak tiers and no holiday rule, so the smallest correct representation is "this provider currently has no relevant time-based pricing rule" — no policy at all. Zen requests are never delayed or blocked, a new Zen model can never be blocked because a DeepSeek policy exists elsewhere, and the verified fact (source, date, note) lives in `VERIFIED_FLAT_PROVIDERS` so `/offpeak status` can explain `UNTRACKED` as "no policy needed". Maintaining a catalog of Zen models as `flatModels` was rejected as unnecessary complexity with the same enforcement outcome.

## 2026-10-15: Held primary requests announce themselves on OpenCode's event stream

A held primary interactive request previously gave no visible feedback, so OpenCode looked hung. The server entrypoint now announces the hold once and the release (or a persisted recovery continuation) at most once, as plugin RPC events (`rpc.opencode-offpeak.hold` / `rpc.opencode-offpeak.resume`) which OpenCode publishes on its own event stream; the TUI entrypoint subscribes with the supported `data.on(...)` API and renders `ui.toast.show(...)`, and a headless client simply has no subscriber. This is the smallest supported server-to-TUI push: no polling, no second process, no new transport, and nothing enters the session, the transcript, or the model context. Notifications are announced only for `kind === "primary"` requests, only by the instance that created the hold (so reloads and restarts cannot duplicate them), never after a user cancel, and never for queue-owned tasks, which keep their existing queue/status semantics.

## 2026-10-15: Auxiliary title requests persist a pending-title marker; recovery never mutates the session

Automatic chat naming is a separate `title` model request. Like every model request it is priced and peak-protected, but OpenCode generates it only once, when the first input of an untitled root session is promoted, and it is not retried by OpenCode itself. A held title therefore persists a small `pending-title` recovery entry (same minimal metadata as a deferral, with `origin: "pending-title"`), and a session can hold a primary continuation and a title marker at the same time. Recovery at the allowed window is a semantic check, never a replay or mutation: a session that already has a title (generated, concurrent, or manually renamed) clears the marker without any request, and a session that still needs one is left to OpenCode's own generation, which every interruption path re-triggers through the same input promotion that continues the session. The marker waits for the title and clears when it appears; a stale marker is dropped with a diagnostic after the settle cap. Evidence: in real OpenCode 2.0.27 fixture runs, a PEAK hold plus a full server restart produced exactly one native title request through the recovery continuation's promotion, and the plugin's own attempted `context.session.update({ title: "" })` was proven unsafe — the plugin host renames the session to an empty title, unlike the HTTP handler's regenerate semantic — so the delivery deliberately mutates nothing and the driver exposes no such call.

## 2026-10-15: Vendor-documented flat-priced models are declared in the policy

OpenCode names sessions with the provider's small model (`model.small`), which for `opencode-go` is `gpt-6-luna`. The built-in policy only listed the DeepSeek models, so every title request was an `UNKNOWN` configured-provider model and failed closed at all hours — automatic titles stopped working when the plugin went live, independent of PEAK. The Go pricing table lists peak/off-peak tiers only for the DeepSeek models; every other documented Go model has one all-hours price. The policy schema therefore supports `flatModels` (explicit globs, `models` takes precedence, everything unmatched still fails closed) and the built-in policy declares the provider's documented flat models. This cannot create peak-priced traffic: it only marks models the vendor prices identically at every hour, and an unlisted future model stays `UNKNOWN` and blocked. Evidence: a live-shaped fixture run (provider `opencode-go`, models `deepseek-v4.1-flash` + `gpt-6-luna`, the stored pre-v0.1.5 policy copy) lost titles under v0.1.4 and generated them under v0.1.5 through the read-time adoption path.

## 2026-10-16: A held request can be cancelled as a refused attempt, without interrupting the session

Another plugin can decide that a parked request is obsolete — the most important real case is a free route that became usable again before the paid window opened, which turns hours of waiting into an immediate answer on the free route. Until now the only way to cancel the hold was `session.interrupt`, which ends the turn; OpenCode's headless runner treats that interruption as terminal, so `opencode run` exited before the resumed work completed. The source of OpenCode 2.0.30 leaves no other lever: session hooks have no typed failure channel (a hook that throws is a defect that fails the execution), and an in-flight `model.request` hook can only return (dispatch), throw (fail), or be interrupted (end the turn). A cancelled hold therefore returns and is refused at the transport boundary, which *is* a typed, retryable failure, so OpenCode's own retry machinery continues the same execution on whatever route the caller selects. The refusal is a credential-free placeholder aimed at a closed loopback endpoint with a marker header; it cannot reach a service, cannot leak anything, and is skipped by the pricing guard. The state transition is synchronous, so a cancellation and a release can never both win: one of them reports the truth and the other is told to wait. Evidence: deterministic tests for the transition, the one-shot refusal, expiry and supersession, the committed race, queue-owned holds and the retry-recovery suppression, plus real-CLI runs (headless and server) where the parked paid request is cancelled, the paid provider receives zero requests, and the same task finishes on the free model with no interruption event.

## 2026-10-13: Peak-aware retry recovery uses OpenCode's retry hook

A request that starts during OFF_PEAK can cross into PEAK and then fail with a retryable transport error (`Timed out waiting for response headers`). OpenCode's own retries would either reach the provider during peak or exhaust and fail the turn, and the guard's boundary hold cannot outlast the header-timeout clock, which starts at attempt start. The plugin now registers OpenCode's supported `retry` hook: during PEAK, with the plugin ON in `auto` mode and a retryable failure, it sets `decision = { retry: false }` and marks the work to continue at the next allowed window (a queue task moves to `WAITING_OFFPEAK`; an interactive session is recorded with minimal persisted recovery metadata scoped to the plugin location). The continuation uses the existing safe continuation prompt in the same session; the failed provider request is never replayed. Non-retryable failures stay `FAILED`, OFF/`queue`/`guard` modes and the override semantics are unchanged, and no new runtime, scheduler, database, or polling loop is added. Evidence: OpenCode 2.0.27 retry hook events (attempts 2–5; `provider.transport`/`provider.internal`/`provider.rate-limit` retryable, `provider.invalid-request` terminal at attempt 2) plus isolated real-binary end-to-end runs proving zero provider traffic during peak and automatic same-session continuation.

## 2026-10-16: A held compaction is recovered semantically, admitted as soon as the session is settled

Manual compact-first — compact the session, then send the next prompt — is a normal workflow, and during PEAK the compaction waits at the pre-model hook like any other request. That hold was memory-only, so a plugin reload, a full server restart, or the 60-minute inactivity sweep ended it as a terminal failed compaction and left the prompt queued behind it stranded; nothing resumed at the off-peak window. The plugin now persists a `pending-compaction` marker for a held compaction (manual and automatic compaction are the same `model.request` kind, so both are covered) and recovers it by admitting OpenCode's own compaction again — never by replaying the provider request. Three source facts shaped the design. First, `session.compact` is the supported semantic trigger, and OpenCode's runner keeps a pending compaction ahead of queued prompts (`packages/core/src/session/inbox.ts` reorders earlier steers behind a pending compaction "so their text stays verbatim after the checkpoint"), so the recovered compaction lands before the prompt that waited behind it. Second, the re-triggered request holds at the same pre-model guard, so recovery during peak still produces zero provider traffic. Third, because of that native priority there is no reason to wait for the allowed window to admit the recovery: it is delivered as soon as the session is settled and idle (any settled outcome, including `succeeded` — unlike a primary continuation, a requested compaction that never ran is not made stale by another completed turn), which is what restores compact-first order after a restart instead of letting a later prompt win the inbox. When a primary continuation coexists with a recovered compaction for one session, both are admitted in the same pass in native order (compaction, then continuation) so the continuation is not dropped by the compaction's own success. The v0.1.7/v0.1.8 transport guard cleared primary recoveries for any non-title kind, which could have let a compact request erase a primary deferral; each request kind now clears only its own recovery class. Evidence: deterministic tests for the exact workflow, reload/restart/inactivity/user-cancel semantics, three-class coexistence, class independence, at-most-once delivery and ordering, and real-CLI fixture runs where a restart during a held compaction still ends with exactly one completed compaction, the prompt behind it running once, and clean recovery state.

## 2026-10-16: Session-scoped off-peak protection is an explicit per-session authorization

Sometimes one interactive session must deliberately run through a peak window while every other session stays protected — for example a long-running refactor that should not pause for three hours. The plugin therefore adds `/offpeak session on|off`: an explicit switch for the current session only, defaulting to ON everywhere, with no timer, no expiry, and no duration syntax. The override lives in OpenCode plugin storage (`opencode-offpeak/session-overrides-v1`) as the absence/presence of one entry per session, so it survives TUI restarts, plugin reloads, and server restarts without touching `offpeak.json` (an override belongs to a session, not to the installation). OpenCode's supported `session.deleted` event removes the entry; stale entries are also reaped by bounded lazy cleanup on start-up, session commands, and status reads. Cleanup only trusts a confident "session not found" signal — a transient error must never delete the state of a session that still exists. The current session is resolved from OpenCode's supported TUI command context (`ui.router.current()`, then the active tab); on the home screen, which has no focused session, the command refuses rather than guessing.

The override is deliberately narrow. It authorizes only requests that evaluate `PEAK` under a verified policy, and only for that one interactive session: `UNKNOWN` and invalid configuration still fail closed, `OFF_PEAK`/`FLAT`/`UNTRACKED` behavior is unchanged, queue-owned sessions never inherit it (a task running in the same OpenCode session still obeys its own task semantics and `/offpeak run-now`), and no other session changes. It covers the session's native lifecycle work (primary, compaction, title, generate) because the user authorized the session, not a request kind. It is checked after every fail-closed guard, so it cannot turn an unverified model into an allowed request.

Two collision points were defined explicitly rather than left implicit. First, a hold that is already waiting must wake immediately: the hold loop re-reads the override after every signal wake-up, and `setSessionProtection` notifies the existing signal and pump, so the same parked request commits with no re-send, no retry, no duplicate provider call, and no new polling, watchdog, or timer; persisted recovery entries for that session are released on the same pass in native order. A refused hold (v0.1.7/v0.1.8 `cancelHold`) is handled before the override check and is never resurrected, and a committed dispatch is never recalled. Second, global precedence: `/offpeak off` remains passive automation (it pauses queue starts and auto-resume, releases nothing, and blocks every session and task), but the explicit per-session grant is newer and more specific, so it applies in `auto`/`queue`/`guard` modes and even while the plugin is globally OFF — for that one session only. This is a deliberate, documented choice in the same category as an explicit `run-now` authorization, not a silent redefinition of `/offpeak off`. Evidence: 19 new deterministic tests (134 total) for the full matrix, and real OpenCode 2.0.30 TUI fixture runs where a held request releases on the spot with exactly one provider call before the boundary, a second session keeps waiting through the same peak window, the override survives a reload and a full server restart, and compaction runs immediately under the override with no pending marker while compact-first behavior with protection on is unchanged.

## OpenCode 2.1 compatibility and the canonical pricing RPC (v0.2.0)

The live host was auto-upgraded from OpenCode 2.0.30 to 2.1.3 and this package
refused to load because the declared range was `>=2.0.26 <2.1.0`. The failure was
the guard itself, not a missing runtime contract: the 2.1.0 breaking change
renamed the session/step payload's `providerState` to `native`, and this plugin
does not read that field. It relies on `model.request`, `http.request` /
`http.response`, the experimental WebSocket hooks, `retry`, `session.execution.*`
and `session.model.selected` events, model transforms, and RPC — all unchanged in
shape and order. The range is therefore extended to `>=2.0.26 <2.2.0` only after
the real TUI and the full free-first coexistence suites pass on 2.1.3. A new
minor line is not claimed on version-number compatibility alone: the guard moves
with tested evidence.

The same release adds a read-only `pricing` RPC that delegates directly to
`evaluatePricing`. `opencode-free-first` needs to know whether DeepSeek Go is in
PEAK before deciding whether Free may be spent. The alternatives were to import
this plugin (couples lifecycles and packaging), copy the weekly windows and
holiday calendar (two authorities that drift), or scrape status text (unstable).
A small RPC is the same pattern as the existing `cancelHold` capability: a
generic, side-effect-free interface on the existing OpenCode plugin RPC channel,
with no new service, queue, timer, or state. The method returns exactly the
canonical answer, including `nextTransition`, so the consumer can cache until the
boundary rather than poll.

## 2026-11-09: OpenCode 2.2 compatibility and the verified-ceiling policy

The live host was upgraded to OpenCode 2.2.6 and this package refused to load
because the declared range was `>=2.0.26 <2.2.0`. The failure was the guard
itself, not a removed runtime contract. `context.app.version` is still a
`string` on 2.2.6 (checked in the published `@opencode/plugin` and
`@opencode/client` declarations and at runtime), and the surfaces this plugin
uses are unchanged: `model.request`, `http.request`, the experimental WebSocket
hooks, `retry`, session lifecycle events, storage, RPC, and the TUI command
context (`keymap.layer`, `ui.toast`, `data.on`, `ui.model`, `ui.router`,
`ui.tabs`, `client.rpc`). The plugin defines no custom renderables, ScrollBox
wrappers, or custom `RenderContext`, so the OpenTUI 0.7/0.8 changes do not
apply. The range is extended to `>=2.0.26 <2.3.0` only after the packed plugin
loads in the real 2.2.6 TUI, `/offpeak status` works there, and the full
deterministic suite passes. The minimum stays at 2.0.26, and the same packed
suite also runs on a real 2.0.26 binary so widening did not silently drop old
hosts.

The `@opencode/plugin` dependency stays pinned at `2.0.26`, the minimum
supported host. The package imports only the identity helper `Plugin.define`
from it; the host owns the runtime contract. Pinning the dependency to the
minimum keeps the TypeScript target honest for the oldest supported host, and a
separate scratch typecheck against `@opencode/plugin@2.2.6` proves the source
also compiles against the newest declarations. Raising the dependency to the
newest host would make the package look like it requires 2.2 while the declared
engine range still promises 2.0.26.

The compatibility error no longer says `Run \`opencode upgrade\``. That advice
was correct when the ceiling was a minimum-version defect, but it is actively
wrong when a newer host is rejected: upgrading is what broke the install. The
message now tells the operator to use a release inside the range or to update
`opencode-offpeak` before using a newer host.

A second, independent cause of a load failure was checked and ruled out on this
host: OpenCode 2.2.3 split managed-policy plugin control from `integration.use`
into `plugin.use`. This host has no managed policy source (`/etc/opencode` does
not exist, `OPENCODE_MANAGED_POLICY` is unset, and `opencode debug config` shows
no `policies` block), so no `plugin.use: deny` is masking the version failure. A
managed deny remains an operator policy finding, not something a wider version
range can fix.

**Ceiling maintenance decision.** This is the second time a narrow upper bound
was overtaken within days: v0.1.6 shipped `>=2.0.26 <2.1.0`, and v0.2.0 shipped
`<2.2.0`. The deliberate policy is to keep an explicit, verified ceiling and
widen it per tested release; removing the ceiling or turning the guard into a
warning would be an architecture change and is not done here. A new minor line
is admitted only after the real packed plugin loads on it and the deterministic
suite passes, with the previous minimum re-verified. The ceiling is therefore
maintenance data, not a claim that future minors are safe by version number
alone.

## 2026-11-16: OpenCode 2.3 compatibility (v0.2.2)

The live host was upgraded to OpenCode 2.3.0 and this package refused to load
because the declared range was `>=2.0.26 <2.3.0`. As in the two previous
ceiling failures, the failure was the guard, not a removed runtime contract.
The published `@opencode/plugin@2.3.0` declarations keep every surface this
package uses: `Plugin.define`, `context.app.version` (still `string`),
`model.request`, `http.request`, the experimental WebSocket hooks, `retry`,
session lifecycle events, storage, `rpc.register`/`client.rpc`, and the TUI
context (`keymap.layer`, `ui.toast`, `data.on`, `ui.model`, `ui.router`,
`ui.tabs`, `client.rpc`). OpenCode 2.3 only adds surfaces — `session.fork`,
`experimental.model.resolve`, `experimental.idle`, artifacts, credentials,
`session.instructions`, `session.list`, and event type filters — and deprecates
`generate` in favour of `experimental.generate.text`, which this package does not
call. The `dist/tui` declarations are byte-identical between 2.0.26 and 2.3.0.

The range is extended to `>=2.0.26 <2.4.0` only after the packed plugin loads in
the real **2.3.0** TUI, `/offpeak status` works there, the full deterministic
suite passes, and the same packed suite still loads on a real **2.0.26** binary.
A zero-paid-traffic headless fixture run on 2.3.0 produced **0 provider requests
before the peak boundary** and exactly **1** at the boundary, in the same
pre-titled session, exit 0.

One behavioural change matters for diagnosis, not correctness: OpenCode 2.3's
SDK no longer makes `rpc.call` wait up to five seconds for a Location that is
still loading plugins. A slash command invoked in the first moments of startup
could therefore reach the server before the plugin's RPC methods register. The
command is itself provided by the TUI entrypoint, and normal interactive use
happens after reconciliation, so no retry loop was added; a future release that
needs startup-time RPC should refresh on the matching `*.updated` event instead
of polling.

The `@opencode/plugin` dependency stays pinned at `2.0.26`, the minimum supported
host, per the 2026-11-09 decision. The source is typechecked against both
`@opencode/plugin@2.0.26` (the pinned minimum) and a scratch
`@opencode/plugin@2.3.0` install, so the newest declarations are verified without
raising the package's runtime dependency.

**Ceiling policy status.** This is the third narrow-ceiling failure in five
weeks (v0.1.6 `<2.1.0`, v0.2.0 `<2.2.0`, v0.2.1 `<2.3.0`). The documented policy
is still an explicit verified ceiling widened per tested release; changing the
guard to a warning or removing the ceiling remains an architecture change that
requires user approval and was not done here. The repeated cost is recorded as a
standing finding: each OpenCode minor currently requires a plugin release before
the host can use it. A future architecture change could distinguish "tested"
from "known-incompatible" so a new minor degrades to a warning with the guard
still failing closed for verified breaks.
