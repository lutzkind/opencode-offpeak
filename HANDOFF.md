# Handoff — 2026-10-15

## Release status

`opencode-offpeak` v0.1.6 is the canonical release:

```sh
opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.6
```

- Release: `https://github.com/lutzkind/opencode-offpeak/releases/tag/v0.1.6`
- Tag commit: `1fe61d2f5979f6f4df32208df7ed3f1cea8c9ae6` (annotated tag object `199ce646facb4a3f7adb4e3cc6b84e1ac232bfaf`; merge of PR #11 `1fe61d2`)
- Implementation commit: `887a352` (`feat(providers): direct DeepSeek API policy, verified Zen semantics, held-request feedback`)
- Attached `opencode-offpeak-0.1.6.tgz` SHA-256: `67704376b1f2aafc7eebbe1b7b9ff0c39f0e89b69b2c8d773fdd25c95467043f` (reproduced byte-for-byte from a clean `v0.1.6` tag archive + `npm ci` + `npm run compile` + `npm pack`; the downloaded release asset hash matches)
- CI: PR #11 `verify` passed on `ubuntu-latest` and `macos-latest` (run `38749826267`)
- The `v0.1.0` through `v0.1.5` tags were not mutated and remain installable.

## 2026-10-15 v0.1.6 — direct DeepSeek API, verified Zen semantics, held-request feedback

**Scope:** first-class support for the direct DeepSeek API provider, a correct and documented stance for OpenCode Zen, and immediate non-chat feedback when a prompt is intentionally held for off-peak pricing — with every v0.1.5 safety and recovery guarantee preserved.

**Provider identities were verified live against OpenCode 2.0.27 before any implementation** (`GET /api/provider`, `GET /api/model`, `opencode.ai/docs/go`, `opencode.ai/docs/zen`, `api-docs.deepseek.com/quick_start/pricing`):

| Provider ID | Registry name | Live models (2026-10-15) | Pricing semantics |
|---|---|---|---|
| `opencode-go` | OpenCode Go | `deepseek-v4.1-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` + 27 others | DeepSeek models have Off-Peak/Peak tiers; every other documented model has one all-hours price |
| `deepseek` | DeepSeek (direct API, `https://api.deepseek.com`) | `deepseek-flash` (DeepSeek-V4.1-Flash), `deepseek-v4-pro` (DeepSeek-V4-Pro-0813) | Peak 01:00–04:00 and 06:00–10:00 UTC Mon–Fri excluding Chinese public holidays; off-peak otherwise; legacy aliases `deepseek-v4-flash`/`deepseek-v4-flash-vision-exp` still accepted and billed at the Flash price |
| `opencode` | OpenCode Zen (`https://opencode.ai/inference/v1`) | 10 models in the live registry (`deepseek-v4.1-flash-free`, `big-pickle`, `cat-jam-free`, …) | One flat all-hours price per model — no peak/off-peak tiers anywhere on the pricing page |

**Implementation:**

- **`deepseek-api` built-in policy (provider `deepseek`)** with the explicit four-ID list (no `deepseek-*` wildcard), reusing the shared `DEEPSEEK_PEAK_WINDOWS` constant and the shared `CHINA_PUBLIC_HOLIDAYS` calendar — no duplicated schedule or holiday logic. Active discovery of the id/date is in `src/policy.ts`.
- **Newly shipped built-in policies reach existing installs:** a stored `offpeak.json` that contains only unmodified copies of the shipped policies appends missing built-ins at read time; any customization makes the stored set authoritative. Verified against the unchanged live file: it now reads as `deepseek-opencode-go` + `deepseek-api` (both with holidays).
- **Zen is documented, not simulated.** No policy exists for provider `opencode`, so requests are never delayed and a new Zen model can never be blocked because a DeepSeek policy exists elsewhere. A verified provider fact (`VERIFIED_FLAT_PROVIDERS`, with source and `verifiedAt`) explains it in status output.
- **`FLAT` pricing state** for vendor-documented all-hours models (Go non-DeepSeek models): allowed, no transition, never held. `/offpeak status` now distinguishes `PEAK`, `OFF_PEAK`, `FLAT`, `UNTRACKED` (with the Zen note) and `UNKNOWN` (blocked with an actionable message: "…is not in the verified off-peak pricing policy for this release. Update opencode-offpeak or add a verified custom policy before using this model.").
- **Held-request feedback** (server `src/engine.ts`/`src/server.ts`, events declared in `src/rpc.ts`, rendered in `src/tui.ts`): a primary interactive hold emits exactly one `rpc.opencode-offpeak.hold` (session, next transition, display-zone deadline such as `08:00 Asia/Bangkok`) and, on release or on a delivered recovery continuation, at most one `rpc.opencode-offpeak.resume`. The TUI subscribes with the supported `context.data.on(...)` API and renders `context.ui.toast.show(...)`. Notifications never enter the session, transcript, or model context; headless runs have no subscriber and stdout stays untouched; auxiliary `title`/`compaction`/`generate` holds are silent; queue-owned sessions keep their queue/status semantics; a user cancel produces no resumption; announcements are instance-scoped so reloads and restarts cannot duplicate them.
- **No guarantee was weakened:** the hard no-PEAK-traffic barrier, same-session recovery, at-most-once delivery, fail-closed `UNKNOWN`, OFF/`queue`/`guard`/`run-now` semantics, retry veto, holiday evaluation and pending-title behaviour are all unchanged, and the 99-test suite includes the v0.1.5 regressions.

**Automated tests:** `npm run lint`, `npm run typecheck`, `npm test` — **99 tests pass** (86 in v0.1.5); `npm pack --dry-run` validated. New coverage: direct DeepSeek window boundaries, weekends, holidays, legacy aliases and unknown-model fail-closed text; provider isolation (the Go policy never covers `deepseek` and vice versa); Zen pass-through for current and hypothetical new models plus the verified note; the `FLAT` state and the display-zone formatter; notification semantics (exactly one hold, exactly one release, silence for auxiliary kinds, no resumption after user cancel, continuation notification after an inactivity recovery, no duplicates across reloads, queue-owned silence, off-peak silence); read-time adoption of newly shipped built-in policies and preservation of customized sets.

**Real OpenCode 2.0.27 validation (local fixture provider, zero paid/peak provider traffic):**

| Scenario | Result |
|---|---|
| OpenCode Go shape, real TUI (`tmux` + `opencode --standalone`) | hold toast at +0.9s; **zero primary provider traffic during the simulated peak window**; resume toast at the boundary; reply rendered; one session, one user message, automatic title; exactly one primary + one flat title request; `/offpeak status` during the hold showed `Pricing: PEAK`, `Requests: BLOCKED`, `Interactive: 1 request waiting for off-peak`, correct policy ID |
| Direct DeepSeek, headless with the server event stream captured | exactly one `rpc.opencode-offpeak.hold` and one `rpc.opencode-offpeak.resume` (`kind: release`); both provider requests (title + primary) only at the boundary; clean recovery state; clean stdout; exit 0; automatic title |
| Zen (`opencode/deepseek-v4.1-flash-free`) in the real TUI | no hold toast; reply inside the simulated peak window (+0.9s); status `Pricing: UNTRACKED`, `Requests: ALLOWED (no policy needed: …)`, `Next transition: none` |
| Reload during the hold | exactly one hold and one resume (no duplicates); both requests only at the boundary |
| Full server restart during the hold | exactly one resume with `kind: continuation`; exactly one continuation; no duplicate original prompt; automatic title; clean recovery state |

**Known platform race (pre-existing, not introduced here):** if `opencode reload` tears down the plugin generation while a released automatic-title request is still in flight, OpenCode's own title commit can be dropped and the session stays untitled until the next prompt. Reproduced with the shipped v0.1.5 plugin under the identical harness (1 of 3 runs kept the title, 2 of 3 did not) and with v0.1.6; the pending-title marker watches for the title and is then dropped with a diagnostic, and the plugin deliberately never mutates a session title (see the v0.1.5 section).

**Live installation (OpenCode 2.0.27):** `opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.6` (the `#v0.1.5` entry was removed with `opencode plugin remove`); `/api/plugin` reports `#v0.1.6` at commit `1fe61d2f5979f6f4df32208df7ed3f1cea8c9ae6` active; the server entrypoint loads from cache `git-opencode-offpeak-7585d22738a7/1792073972071`; `opencode reload` applied. `/offpeak status`: ON, `auto`, OFF_PEAK, queue/waiting/interactive/recovery/titleRecovery/failed all 0, and `pricing` for each provider class reports `deepseek-opencode-go` (Go), `deepseek-api` (direct, adopted without editing the file), `FLAT` for `gpt-6-luna`, and `UNTRACKED` + the Zen note for `opencode`. Live OFF_PEAK smoke at 14:21Z: session `ses_ec00ff034ffe4vmWVAoGEuDcCh` replied `offpeak v0.1.6 live ok` and received the automatic title `Exact reply: offpeak v0.1.6 live ok`; the test session was removed afterwards through the supported session API, leaving `session_v2`, `session_message`, queue and recovery clean.

**Housekeeping:** the merged `release/v0.1.5` and `release/v0.1.6` branches were deleted locally and on `origin`; the local-only `peak-defer` branch (a v0.1.4 development branch whose content is superseded by the released v0.1.4 code, not merged, not on `origin`) was inspected and intentionally left in place rather than discarding unique commits; stale current-state references in the lower sections of this file were corrected to point at v0.1.6.

**Remaining intentional limitations (v0.1.6):** a model that matches neither the peak nor the flat list under a peak-priced provider still fails closed at all hours until a verified policy update ships; the plugin cannot force a title regeneration for an idle session (OpenCode 2.0.27 exposes no plugin-facing regeneration call — see v0.1.5); notifications are TUI-only by design (headless clients have no subscriber); the annual policy review now also re-checks the direct-API model list and the Zen pricing page; a TUI process started before this install keeps its old TUI entrypoint until relaunched (the server-side plugin is v0.1.6 and a fresh TUI loads v0.1.6).

## 2026-10-15 v0.1.5 — automatic titles restored and pending-title recovery

**Reported symptom:** sessions completed successfully but never received their automatic OpenCode-generated title, noticed after work was deferred through a PEAK window.

**Live state before the fix (verified):** OpenCode CLI and background service **2.0.27**; `/root/.config/opencode/opencode.json` pinned exactly `git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.4`; `/api/plugin` reported version `4244f177afe0adfc0017d8dcc695a05274be7d27` with server+TUI active; `/offpeak status` ON / `auto` / OFF_PEAK with queue, recovery, interactive and failed all 0. The plugin's own KV documents (`opencode-offpeak/queue-v1`, `opencode-offpeak/recovery-v1`) were empty.

**Root cause (reproduced, not assumed):** OpenCode prepares automatic session naming as its own `title` model request that uses the provider's *small* model, not the session model. `SessionContext.selectTitle` resolves `model.small(providerID)` (families `gpt-luna`, `gemini-flash-lite`, `gemini-flash`, `claude-haiku`); for `opencode-go` that is `gpt-6-luna`. The built-in policy listed only the four DeepSeek models, so every title request evaluated `UNKNOWN` for a configured provider and the v0.1.4 `model.request` guard failed it closed — at every hour, not only during PEAK. The first observed loss is exactly when the plugin went live on 2026-10-11: every later real session has a NULL title (checked directly in `session_v2`).

- Fixture reproduction with the live shape (provider `opencode-go`, models `deepseek-v4.1-flash` + `gpt-6-luna`, the stored pre-release policy copy): v0.1.4 blocked the title request (`model.request kind=title model=opencode-go/gpt-6-luna`, exit 0, one provider request total, session untitled); the same config on this release adopted the flat model list from the stored copy and generated the title.
- Live probe on 2026-10-15 05:39Z (OFF_PEAK, before the fix): `opencode run --standalone` completed with `title probe ok` and the session row was `<NULL>`.

**Title lifecycle (OpenCode 2.0.27 source):** `SessionTitle.generate` runs only (a) when a root session's input is promoted and the session is untitled, or (b) through the HTTP handler `PATCH /api/session/:id {"title": ""}`. `isExactRootFallback` treats a missing title or the exact `New session - <created ISO>` string as untitled; the rename commit is guarded by a sequence compare-and-set and by `current.title !== session.title`, so a concurrent rename (or a manual rename) wins. OpenCode does not retry an interrupted title request on its own.

**Fix (v0.1.5):**

- `flatModels` in the policy schema: explicit, vendor-documented patterns for models with a single all-hours price. The Go pricing table lists Off-Peak/Peak tiers only for the DeepSeek models, so the built-in policy declares the documented flat models (GPT 6/5.6 Luna, Claude Haiku 5.5, Gemini 4 Argon Contributor, GLM, Kimi, LongCat, MiMo, MiniMax, Muse Spark, Qwen, Hy, Space Bunny, Step 5 Preview Free, Cat Jam Free, Grok). `models` wins on overlap; an unmatched model still fails closed, so an unlisted future model can never silently gain peak traffic. An unmodified stored copy of the built-in policy adopts the flat list at read time — which is how the live install picked it up without editing `offpeak.json`.
- A held title request persists a semantic `pending-title` recovery entry. Recovery entries are keyed per origin (`legacy`/`deferred`/`retry-failure`/`pending-title`), so a session can carry a primary continuation and a title marker at the same time; v0.1.4 stored only one entry per session, so a held title could shadow a primary deferral (a latent hazard this release removes).
- Delivery is a check, never a replay or a mutation: a session that already has a title (generated, concurrent, or manually renamed) clears the marker without any request; a session that still needs one is left to OpenCode's own generation, which every interruption path re-triggers through the same input promotion that continues the session. Stale markers are dropped with a diagnostic after the settle cap. `/offpeak status` reports `titleRecoveryWaiting`.
- The plugin never calls `session.update` for titles. In the 2.0.27 plugin host, `update({ title: "" })` renames the session to an **empty** title (it lacks the HTTP handler's regenerate branch); a fixture run proved this can also discard a legitimately generated rename through OpenCode's own sequence guard (observed empty title in the first restart run before the delivery was corrected). The driver therefore exposes no title-mutating call at all.
- The transport guard (`http.request`, `experimental.ws.handshake`, `experimental.ws.send`) now receives the request kind and removes only its own recovery class: a released title clears a pending title, a released primary clears a primary continuation, and neither can clear the other.

**Automated tests:** `npm run lint`, `npm run typecheck`, `npm test` — **86 tests pass** (71 before); `npm pack --dry-run` validated. New deterministic coverage: flat models allowed inside DeepSeek peak windows, DeepSeek windows unchanged, overlap precedence, ambiguous and invalid lists failing closed, pending-title persistence across reload, manual-rename and already-titled safety, the exact creation-time fallback still counting as untitled, child and missing sessions, user cancel versus inactivity, at-most-once semantics across repeated reloads, coexistence with a primary deferral, and read-time adoption of the flat list by an unmodified stored policy.

**Real-binary validation (OpenCode 2.0.27 + local fixture provider, no paid traffic):**

| Scenario | Result |
|---|---|
| Live-shaped config under v0.1.4 (OFF_PEAK) | title request `opencode-go/gpt-6-luna` blocked, session left untitled, 1 provider request |
| Live-shaped config under v0.1.5 (stored pre-release policy copy) | flat list adopted, title request allowed, title generated; 1 title + 1 primary request |
| PEAK window, covered title model, uninterrupted (`peak-both`, `peak-primary`) | zero provider traffic during PEAK; `pending-title` + `deferred` markers persisted together; both released at the boundary; exactly one title + one primary request; recovery clean |
| PEAK + `opencode reload` | markers persisted; original holds released at the boundary; one title + one primary request; no duplicate prompt; recovery clean |
| PEAK + full server restart | markers survived in storage; new instance reported `recoveryWaiting: 2`, `titleRecoveryWaiting: 1`; boundary produced exactly one continuation and exactly one native title request; session titled; recovery clean |
| Uncovered title model during PEAK (`peak-luna-uncovered`) | title request still fails closed; zero provider traffic; only the primary request at the boundary (deliberate `UNKNOWN` invariant) |

**Live installation:** `opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.5` (the `#v0.1.4` entry removed with `opencode plugin remove`); `/api/plugin` reports `#v0.1.5` version `f9069e8918edb3df6ed407b2f1f90182d93036a9` active; cache `git-opencode-offpeak-aa46d2693f65/1792060013697` resolves commit `f9069e8`; `opencode reload` applied. `/offpeak status`: ON, `auto`, OFF_PEAK, queue/recovery/interactive/titleRecovery/failed all 0. Live policy read path verified against the unchanged stored `offpeak.json`: the adopted flat list has 15 patterns; `gpt-6-luna`/`gpt-5.6-luna`/`claude-haiku-5-5` are OFF_PEAK at all hours including 2026-10-16T02:00Z while `deepseek-v4.1-flash` is PEAK there and an unlisted model is `UNKNOWN`. Live OFF_PEAK smoke (10:28Z): session `ses_ec0e4b113ffetGhgbGpJRgpp4d` replied `offpeak v0.1.5 live ok` and received the automatic title `Exact reply requested: offpeak v0.1.5 live ok`; the test session was removed afterwards through the supported session API, leaving `session_v2`, `session_message`, queue and recovery clean.

**Remaining intentional limitations (v0.1.5):** a title request for a model that matches neither the peak nor the flat list still fails closed at all hours (the invariant; extend the policy for new models); the plugin cannot force a title regeneration for an idle session that never receives another promotion, because OpenCode 2.0.27 exposes no plugin-facing regeneration call and its plugin-host `session.update` cannot regenerate — in practice every interruption path re-triggers naming through the continuity promotion, and a pending marker that never sees a title is dropped with a diagnostic after the settle cap; the annual policy review must also re-check the flat model list against the Go pricing table; a TUI process started before this install keeps its old TUI entrypoint until relaunched (the server-side plugin is v0.1.5 and a fresh TUI loads v0.1.5).

## 2026-10-14 v0.1.4 — pre-model peak deferral (the remaining header timeout)

**Live state before the fix (verified, not assumed):** OpenCode CLI and the background service ran **2.0.27**; `/root/.config/opencode/opencode.json` pinned exactly `git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.3`; `/api/plugin` reported `opencode-offpeak` at `38c8cb250c48c50aecd972eff64840e1f68d0cfa` with server+TUI active; the server loaded `src/server.ts` from the v0.1.3 tag cache `git-opencode-offpeak-fabcc95a158b`. The single TUI process (PID 4053968) started 2026-10-14 07:49, after the v0.1.3 install, so the loaded server and TUI code were v0.1.3. Live `/offpeak status`: ON, mode `auto`, OFF_PEAK, queue/recovery/failed all empty.

**The reported error was real and live.** `/root/.local/share/opencode/log/opencode.log` contains the exact sequence: this session's task prompt was submitted at `2026-10-14T09:30:29Z` (PEAK 06:00–10:00 UTC) and the server logged `Failed to drain Session — AI.Error.Transport: Timed out waiting for response headers` at `09:35:29Z` — **exactly 5 minutes later**. The v0.1.3 retry hook vetoed the retry and the persisted recovery delivered the same-session continuation at the `10:00:00Z` boundary (DB message seq 11). Earlier identical failures were logged at 06:05, 06:10, 07:54, 07:55, 08:04 and 09:35 UTC on 2026-10-14 — all inside PEAK windows.

**Root cause (OpenCode 2.0.27 source, verified in `packages/ai` / `packages/core`):** the provider transport wraps `runtime.http.execute(...)` in `Effect.timeoutOrElse(request.http.headerTimeout ?? 300_000ms)` (`packages/ai/src/route/transport/http.ts`), and the plugin's `http.request` hook is invoked *inside* that wrapped call (`packages/core/src/session/model-request.ts` builds `options.http` middleware that triggers `http.request` and then calls the real handler). The response-header-timeout clock therefore starts at attempt start, before the hook chain completes; the v0.1.2–v0.1.3 hold inside `http.request` could not outlast it. `model.request`, by contrast, is triggered in `SessionModelRequest.prepare()` — after the `context`/`title` hooks and **before** `steps.attempt` starts the transport attempt. The default header timeout is `DEFAULT_HTTP_TIMEOUT_MS = 300_000` (`packages/ai/dist/schema/options.js`), which matches the observed 5-minute gap exactly.

**Deterministic reproduction (real 2.0.27 binary + local fixture provider, no paid traffic):** a probe plugin holding `http.request kind=primary` for 10s with a 5s provider `headerTimeout` reproduced the failure — the timeout fired 5s in, the hook kept running (a stale waiter; JS promises are not effect-cancelled), OpenCode retried 4 times and the turn ended with `Error: Timed out waiting for response headers`, exit code 1, and the fixture received only the title request. The same hold applied to `model.request kind=primary` produced **no timeout**: the hold ran to completion, the provider request was sent only after release, and the run exited 0 with one reply. With the actual v0.1.3 plugin and a short simulated PEAK window, the same harness failed at +5.1s (`Failed to drain Session` at 11:03:29.7Z for a submission at 11:03:24.6Z) and the session continued only through the retry-recovery continuation at the boundary.

**Fix (v0.1.4):**

- The pre-model `model.request` hook defers a peak-priced request in `auto` mode before any provider attempt (or its header-timeout clock) exists. Nothing reaches the provider while pricing is blocked; the same session continues the same turn when the boundary arrives. No timeout to outlast, no retry used as the waiting mechanism, no synthetic continuation, no duplicate prompt, no new session.
- The transport guard (`http.request`, `experimental.ws.handshake`, `experimental.ws.send`) is unchanged and remains the final hard barrier; `queue`/`guard`/OFF behavior for interactive requests is exactly as before, and UNKNOWN still fails closed.
- A held **primary** interactive request persists a deferral (`RecoveryRepository`, origin `deferred`, minimal metadata) while it waits and removes it again on normal release, so a plugin reload or server restart during PEAK still delivers exactly one same-session continuation once the allowed window arrives (a reload keeps the original hold alive when the plugin instance survives; a restart delivers the continuation as soon as the location is next active and pricing allows). The origin field distinguishes deferrals from v0.1.3 retry failures and is backward compatible with stored entries.
- **Origin-aware interrupts:** the plugin subscribes to OpenCode's event stream (`session.execution.interrupted`). `inactivity` (OpenCode's 60-minute location-activity sweep) keeps the deferral and aborts the stale hold; `user` clears a deferral and aborts the hold (a cancel never continues); `superseded`/`shutdown` abort the hold and leave the outcome to OpenCode's own execution-claim recovery. No new runtime, daemon, database, scheduler, or polling loop.
- The **v0.1.3 cross-boundary recovery is preserved**: a request that started OFF_PEAK, was accepted, and failed retryably after crossing into PEAK still has its retry vetoed (`decision = { retry: false }`) and continues in the same session at the next allowed window.

**Chinese public holidays are full-day OFF_PEAK (v0.1.4):**

- Rule source: DeepSeek's official pricing documentation (`https://api-docs.deepseek.com/quick_start/pricing`): "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, **excluding Chinese public holidays**. All other hours are off-peak, including weekends and **Chinese public holidays in full**." The OpenCode Go pricing page documents the same weekly windows for this provider.
- The policy model gains optional full-day OFF_PEAK exception calendars (`year`, `dates`, `timeZone`, `source`, `verifiedAt`, `description`). A listed date overrides every weekly PEAK window for the whole calendar day, evaluated in the calendar's own time zone (`Asia/Shanghai`), so the host-local time zone never matters. `nextTransition` skips holiday PEAK windows (the scan now covers 14 days so the 9-day Spring Festival cannot hide the next real transition).
- The 2026 calendar ships in `src/holidays.ts`, sourced from the official State Council notice 国办发明电〔2025〕7号 (`https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html`, published 2025-11-04): **Jan 1–3, Feb 15–23, Apr 4–6, May 1–5, Jun 19–21, Sep 25–27, Oct 1–7** (33 dates; Jan 1–3 confirmed, etc.). Weekend make-up working days (Jan 4, Feb 14, Feb 28, May 9, Sep 20, Oct 10) remain OFF_PEAK because weekends are always off-peak and are deliberately not modelled as workdays. A year without a calendar keeps the deterministic weekly schedule — no future dates are guessed.
- **Annual maintenance is required**: the State Council publishes the next year's arrangement each November; add the next calendar to `src/holidays.ts` (one data update; `docs/pricing-policies.md` documents the shape).
- **Provider caveat (annual re-check):** OpenCode Go's own page omits the holiday clause, and upstream issue `anomalyco/opencode#53071` (open since 2026-10-04, no vendor reply) reports peak-rate billing during the 2026 National Day holiday; the account's October aggregate usage is also consistent with nominal billing. Go exposes no per-request billed cost, so the task's October 1–7 billing comparison is not observable and was explicitly non-blocking. The rule is implemented per the canonical DeepSeek documentation and the later task instruction; re-check the upstream issue and both pricing pages before each yearly calendar update.
- **Config migration:** a stored `policies` array that is an unmodified copy of the built-in policy (same id, providers, models, time zone, multiplier, weekly windows) adopts the built-in holiday calendar when read in `src/config.ts`. The live `/root/.config/opencode/offpeak.json` persisted such a copy from an earlier toggle, so the live install gained the holidays without editing the file; customized policies and explicit `holidays` lists are preserved exactly.

**Automated tests (71 pass — `npm run lint`, `npm run typecheck`, `npm test`, `npm pack`):** new deterministic coverage for the pre-model deferral released by the scheduled boundary timer with zero provider traffic, auxiliary-kind holds without deferrals, a queue-owned session held at the guard returning to RUNNING at the boundary, deferral persistence across a plugin reload, user/inactivity/shutdown interrupt semantics, normal-release deferral cleanup, stored-policy holiday adoption, and the full 2026 holiday policy (every period off-peak in both peak windows, make-up workdays off-peak, adjacent days normal, `nextTransition` skipping holidays, Asia/Shanghai calendar-time-zone semantics with synthetic policies, unknown years deterministic, validation fail-closed, empty holiday lists). Existing suites cover OFF/`queue`/`guard`/run-now/UNKNOWN/UNTRACKED/non-retryable/restart-recovery semantics unchanged.

**Real OpenCode 2.0.27 fixture validation (v0.1.4 build, local fixture provider, short local policy windows, no paid traffic):** interactive PEAK submission deferred for the whole window with zero fixture requests, released exactly at the boundary minute, one session, one user + one assistant, exit 0; OFF_PEAK→PEAK crossing veto with zero provider traffic during PEAK and one same-session continuation at the boundary; queue task queued during PEAK waited in `WAITING_OFFPEAK`, auto-started exactly at the boundary and completed with one session and one request; `opencode reload` and a full server restart during a deferral both ended with exactly one continuation and no duplicate prompt; the v0.1.3 plugin under the same harness fails at +5.1s as described above.

**Live installation (OpenCode 2.0.27):**

- `opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.4` now lists exactly `#v0.1.4` in `/root/.config/opencode/opencode.json` (the stale `#v0.1.3` entry was removed with `opencode plugin remove`); cache `git-opencode-offpeak-c5f94a9feee0` contains the v0.1.4 sources including `src/holidays.ts`.
- The shared background service was reloaded with the supported `opencode reload`. `/api/plugin` reports `opencode-offpeak` at `4244f177afe0adfc0017d8dcc695a05274be7d27` with server+TUI active; `/offpeak status` reports ON, `auto`, OFF_PEAK, empty queue/recovery.
- Live holiday verification with the released code against the live config file: `2026-10-01T02:00Z` (National Day, Thursday, nominal PEAK window) → **OFF_PEAK**, `2026-10-12T02:00Z` (normal Monday) → **PEAK**, `2026-10-10T02:00Z` (adjusted Saturday workday) → **OFF_PEAK**.
- Safe live OFF_PEAK smoke: `opencode run -m opencode-go/deepseek-v4.1-flash` replied `offpeak v0.1.4 live ok` at 11:10 UTC (OFF_PEAK) through the live plugin.
- The TUI process PID 4053968 (started 07:49, before v0.1.4) still executes the v0.1.3 **TUI entrypoint** until it is relaunched; the server-side plugin is v0.1.4 and a fresh TUI loads v0.1.4. Only that TUI needs relaunching for the TUI-side code; no unrelated session was terminated.

**Remaining intentional limitations (v0.1.4):** shutdown/reload fails a live deferral closed rather than guessing (the persisted deferral delivers the continuation instead); after a full server restart the continuation is delivered when the session's location is next active (OpenCode boots location services and plugins lazily) and can therefore lag the boundary; a request that passes `model.request` in OFF_PEAK and reaches the transport guard just after PEAK begins is still held at the transport guard (the final barrier) and could hit the 5-minute header timeout in that sub-millisecond boundary case; a user cancel clears a deferral and never auto-continues; OpenCode Go's holiday billing is not independently verifiable (annual re-check above); the retry hook still does not expose the request kind, so auxiliary retries during PEAK register a recovery entry like v0.1.3 did (a primary deferral for the same session supersedes it).

## Housekeeping and documentation

- Stale current-state wording from previous releases was corrected in this release: package/install references now point at v0.1.4 (`README.md`, `RELEASING.md`, `docs/troubleshooting.md`), the v0.1.2-era "held at the boundary" descriptions were rewritten for the pre-model deferral (`README.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `docs/concepts.md`, `docs/configuration.md`, `docs/queue.md`), and the old "User action required: None. The v0.1.2 GitHub release…" wording is superseded by this section. Historical release sections were left intact.
- Branch housekeeping: the merged `release/v0.1.1`, `release/v0.1.2`, and `release/v0.1.3` branches were deleted locally and on `origin` (the tags keep the releases); `release/v0.1.4` was deleted after the merge.

## 2026-10-13

## 2026-10-13 OpenCode 2.0.27 upgrade and validation

**Upstream:** the latest official OpenCode v2 release is **2.0.27** (published 2026-10-12 04:15 UTC; verified through the official update channel `https://opencode.ai/update/api/latest/cli/opencode`, the official npm `@opencode/cli@latest`, the official changelog, and the official GitHub tag `v2.0.27`). No 2.1.x release exists. The live installation was on 2.0.26 because the binary was last installed 2026-10-09 (before 2.0.27 was published) and the update policy is the default `notify`, so nothing auto-upgrades; a running background service also keeps executing the binary it started with until it is restarted.

**Compatibility:** the `@opencode/plugin` package diff between 2.0.26 and 2.0.27 has identical file lists; the only changes are internal version bumps and one `effect` import path in `dist/promise/adapter.js`. No public plugin API surface changed.

**Validation (all passed):**

- Isolated run of the real 2.0.27 binary with the exact `#v0.1.2` tag and a local OpenAI-compatible fixture provider: server + TUI entrypoints load; `/offpeak status`, `pricing`, `off`, `on`, `queue`, `list`, `cancel`, `remove`, `retry`, `resume`, and `run-now` all work; interactive peak hold with zero provider traffic until the boundary minute; automatic boundary release in the same session; queue-owned auto-resume; queue-mode resume; UNKNOWN fails closed; UNTRACKED passes through; OFF stays passive; FAILED to retry to COMPLETED; persistence across a TUI restart; one user and one assistant message per request (no duplicates).
- Repository suite: 45 tests pass with `@opencode/plugin@2.0.27` in `node_modules` and the 2.0.27 host binary for the real TUI smoke test. The `package.json` dependency pin stays at 2.0.26 by design (the minimum supported version) and the package test enforces it.
- Live CLI upgraded through the official v2-aware path (`opencode upgrade 2.0.27 --method curl`, not the legacy `/install`); the installed binary hash matches the official 2.0.27 artifact byte-for-byte.
- Live background service restarted at a quiet moment (it hosts other active sessions) and verified on 2.0.27: `/api/info`, the CLI, and a fresh TUI all report 2.0.27; plugin `#v0.1.2` is active with no startup failures.
- Live boundary test with a short temporary policy: an interactive request was held (`Interactive: N requests waiting for off-peak`) and released at the boundary in the same session (1m48s) with exactly one user and one assistant message; a queue task queued during the window completed at the boundary in one session/prompt; the production policy was restored afterwards.
- `opencode reload` persistence: a task queued while the plugin was OFF persisted across the reload (`QUEUED`) and completed after `/offpeak on`.

**Decision:** no code or compatibility-metadata change was required. `engines.opencode` already covers 2.0.27 (`>=2.0.26 <2.1.0`), and the API package pin stays at the minimum supported 2.0.26, so no new plugin release was cut; `v0.1.2` remains the installed release.

**Residual state:** the long-running user TUI (PID 1366942, started before the upgrade) still executes 2.0.26 host code until it is restarted; it is inside the supported range and causes no failures. Fresh TUIs run 2.0.27. The separate `tui-package` scratch service from an earlier phase was left untouched. No temporary test policies or test tasks remain; the queue is empty and the plugin is ON in `auto` mode.

## 2026-10-13 peak-aware retry recovery (v0.1.3)

**Root cause:** a request that starts during OFF_PEAK can cross into PEAK and fail with a retryable transport error (`Timed out waiting for response headers`). Two mechanisms then lose the work: (a) OpenCode retries the request up to three times, and each retry is a new paid request that would either reach the provider or be held by the guard during PEAK and time out while held, because the header-timeout clock starts at attempt start; (b) when the retry budget is exhausted, the turn fails terminally and the plugin has no pending pre-transport request left to release at the next boundary.

**OpenCode 2.0.27 retry lifecycle (measured with the real binary and a local withholding fixture, not assumed):**

- Header timeout → `error.type = provider.transport`, default decision `{ retry: true, delay }`; retry hook calls at attempts 2, 3, 4, then `{ retry: false }` at attempt 5 (three retries, four physical attempts).
- `provider.internal` (500/503) and `provider.rate-limit` (429) are retryable; `provider.invalid-request` (400) is terminal at attempt 2 (`{ retry: false }`).
- Every retry attempt re-enters `context` → `model.request` → `http.request`, so the guard sees every physical attempt.
- The header-timeout clock starts at attempt start, before the hook chain completes; a guard hold longer than the provider's header timeout times out while held. This is why very long peak holds could previously fail.
- The retry hook runs after classification and before any retry is scheduled; `event.decision` is mutable; the hook receives `{sessionID, agent, model, error, attempt, decision}` (no request kind).

**Implementation (v0.1.3):**

- `src/server.ts` registers `context.session.hook("retry", ...)`; `src/engine.ts` adds `noteRetryFailure()`: when the plugin is ON, mode is `auto`, the failure is retryable (`willRetry` or a retryable error type), and the model's policy is blocked, the engine returns `hold` and the hook sets `decision = { retry: false }`.
- Queue task: `RUNNING` → `WAITING_OFFPEAK` (persisted task state, session ID kept); the existing pump resumes it at the next allowed window with the existing safe continuation prompt.
- Interactive session: minimal recovery metadata (`sessionID`, provider/model, location) is persisted in OpenCode plugin storage (`opencode-offpeak/recovery-v1`); the engine delivers the same continuation once, at the next allowed window, only when the session has settled with a failed/interrupted outcome. New session requests supersede a pending recovery; sessions that never settle are dropped without sending.
- No new runtime, scheduler, database, daemon, or polling loop: delivery is driven by the existing pump, signal, and boundary timer; `/offpeak status` shows `recoveryWaiting` as `Recovery: N session(s) waiting for off-peak`.

**Safety:** no retry reaches the provider while pricing is blocked; the continuation never replays the failed provider request, never creates a session, and never duplicates the user prompt; non-retryable failures stay `FAILED`; failures while pricing is allowed keep normal retry behavior; OFF/`queue`/`guard` modes and `run-now` overrides are unchanged; UNKNOWN fails closed; UNTRACKED passes through; ambiguous `RUNNING`-after-crash still requires an explicit retry.

**Automated tests:** 52 pass (lint, typecheck, tests, pack), including the new retry-recovery suite listed in `docs/releases/v0.1.3.md`.

**Isolated end-to-end evidence (real 2.0.27 + local fixture provider withholding headers until the window end):** a queue task and an interactive message started during OFF_PEAK, failed retryably after crossing into PEAK, were vetoed (no further retry events), produced zero provider requests during the entire PEAK window, stayed `WAITING_OFFPEAK`/`Recovery: 1`, and both continued in their same sessions at the boundary with the continuation prompt.

**Live validation (OpenCode 2.0.27 + v0.1.3 on the shared server, 2026-10-13):**

- Normal off-peak DeepSeek operation: `opencode run -m opencode-go/deepseek-v4.1-flash` replied `offpeak v0.1.3 live ok`.
- Temporary local fixture provider + short test policy (both removed afterwards): an interactive `opencode run` message and a queue task started during OFF_PEAK, failed retryably after crossing into PEAK, were vetoed, produced **zero fixture requests during the entire PEAK window**, stayed `WAITING_OFFPEAK`/recovery, and both continued in their **same sessions** at the boundary — the task `COMPLETED` (`ses_eca59f7a7fferT5ghI5ZhcL5dE`) and the interactive session succeeded (`ses_eca5a0b3affe3ZgfqjjoYfdmiK`, 2 user / 2 assistant messages) with the continuation prompt.
- The production policy and provider configuration were restored, the test task was removed, the queue is empty, the fixture stopped, and the plugin is ON in `auto` mode.

**Remaining intentional limitations:** the retry hook does not expose the request kind, so auxiliary requests are not distinguished from the agent loop; a session that never settles is not continued automatically; recovery entries are scoped to the plugin location, and two plugin instances for the same location are not coordinated (the same class as the existing shared queue).

## 2026-10-12 interactive boundary wait (v0.1.2)

**Defect:** a normal interactive OpenCode request for a supported model was thrown away at peak pricing. Queue-owned `auto` tasks already waited for the next boundary, but `guardRequest()` had no interactive equivalent, so a user message sent during peak failed with `PricingBlockedError` and nothing happened when off-peak returned.

**Fix:**

- `guardRequest()` now holds a normal interactive request at the provider transport boundary when the plugin is ON, mode is `auto`, and the model matches a configured policy that is currently blocked. It creates no task, session, or persistent state.
- The hold reuses the existing shared signal plus one timer scheduled for the policy's `nextTransition`; it is released exactly once when the plugin is enabled and pricing allows. There is no new daemon, scheduler, database, or polling loop.
- `queue`/`guard` modes still block interactive peak requests immediately; OFF stays passive and never releases a held request; UNKNOWN still fails closed; UNTRACKED still passes through; shutdown fails a held request closed instead of releasing it under an uncertain pricing state.
- `/offpeak status` reports held interactive requests (`interactiveWaiting`).
- Deterministic manual-clock tests cover the hold, the boundary release without external wake-ups, single release, same-session preservation, no duplicate prompt/session, OFF passivity, fail-closed shutdown, mode semantics, and unchanged queue-owned auto resume. The server entrypoint test exercises the real hook end to end.

**Live validation (OpenCode 2.0.26, 2026-10-12):**

- Three consecutive real-TUI holds on the shared live server with a short deterministic test policy (temporary policy scoped to `opencode-go/deepseek-v4.1-flash`, real time off-peak): each interactive reply completed exactly at the scheduled boundary with no further input; each session ended with exactly one user and one assistant message.
- One live queue-owned task queued during a blocked window went `WAITING_OFFPEAK` and resumed automatically at the boundary in one session with one prompt.
- A final combined check against the installed `#v0.1.2` tag: interactive reply at the boundary (`offpeak final ok`) and queue-owned task `d14f1a41-2b6c-461a-a484-7e3d042fbb32` completed at the boundary with one session/prompt; both temporary smoke tasks were removed afterwards and the original policy was restored.
- An isolated single-instance TUI with a local OpenAI-compatible fixture provider showed `Interactive: 2 requests waiting for off-peak` while held, zero fixture traffic until the boundary, and the first provider request at the boundary minute; the session ended with one user and one assistant message (the second request was OpenCode's own title generation).
- No peak-priced traffic was produced: all released provider calls occurred at real off-peak times, and the fixture tests contacted no provider at all.

**Operational notes from the live run:**

- In the shared live server, plugins load once per workspace, so the in-memory `interactiveWaiting` count is only visible from the plugin instance that holds the request; the live status probes may show `0` even while a request is held (the hold/release behavior itself is unaffected). The counter rendering was verified in the isolated single-instance real-TUI fixture and in the automated entrypoint tests.
- A pre-existing terminal `COMPLETED` record from the previous closeout (`da6de0b6-9475-41c4-a698-c9c241ff8585`) was removed accidentally during the first live script's task-ID extraction (the extraction picked the first UUID in the list toast). Its OpenCode session is preserved; record removal is a supported operation and deletes no session. The queue was otherwise left clean.

## v0.1.1 (historical)

`opencode-offpeak` v0.1.1 remains installable from its own tag:

```sh
opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.1
```

The release is at `https://github.com/lutzkind/opencode-offpeak/releases/tag/v0.1.1`. Its tag points to `764d1ab4b095a17813d0f63d6fdf0d92e8a1d248` (merge of PR #6), and the attached `opencode-offpeak-0.1.1.tgz` has SHA-256 `36a3b14a1f22be656d5838b2edc2aa7d3a8d9208f457b48d9c5bb589d14a0495`. It added the tested OpenCode compatibility enforcement, the documented `Plugin.define(...)` TUI shape, `/offpeak remove`, and the real-TUI regression smoke test.

## 2026-10-12 keymap repair (root cause and fix)

**Symptom:** the live log showed `plugin operation failed ... error="Keymap.Provider is missing" ... plugin=opencode-offpeak ... role=cli` (four occurrences: 06:52:07, 06:52:32, 07:18:21, 07:18:29 on 2026-10-11).

**Root cause:** every occurrence came from one long-running TUI process (PID 2844814, run `2a76d75b`, started 2026-10-06, executable `/root/.opencode/bin/opencode (deleted)`) that was still executing OpenCode **2.0.18** host code after the in-place upgrade to 2.0.26. OpenCode releases before 2.0.26 activate TUI plugins outside the Solid keymap provider owner, so the documented `context.keymap.layer()` call in `setup` throws `Keymap.Provider is missing`; the same call succeeds on 2.0.26. The plugin integration itself was correct for the supported host: a fresh v2.0.26 TUI with the live configuration reconciled all 13 plugins with no failure and registered `/offpeak` before any code change.

**Fix:**

- `package.json` declares `engines.opencode: ">=2.0.26 <2.1.0"` (the actually tested range).
- Both entrypoints call `assertSupportedOpenCode(context.app, ...)` at startup and fail with an explicit, actionable upgrade error on unsupported or unknown hosts. The stale 2.0.18 process now logs that clear error instead of the keymap error.
- Both entrypoints use the documented `Plugin.define(...)` form; the TUI registers `/offpeak` via `context.keymap.layer(...)` exactly as documented. No `tui.json`/`cli.json` workaround exists or is needed.
- `/offpeak remove <task-id>` deletes terminal (`COMPLETED`, `FAILED`, `CANCELLED`) queue records; active tasks must be cancelled first.

**Live validation (2026-10-11 → 2026-10-12, OpenCode 2.0.26):**

- `npm run lint`, `npm run typecheck`, `npm test` (39 tests, including a real TUI smoke test), `npm pack` all pass; CI on PR #6 passed on ubuntu-latest and macos-latest.
- The repaired commit was installed, the supported service reloaded with `opencode reload`, and a fresh real TUI registered `/offpeak` with zero plugin failures.
- `/offpeak status`, `/offpeak on`, `/offpeak pricing`, `/offpeak list`, `/offpeak queue`, and `/offpeak remove` were exercised in the real TUI. One harmless DeepSeek/OpenCode Go smoke task (`8b16cb23-7985-4a1c-851e-62168973fc0e`, session `ses_ed6091018ffeGD8tk8M6DlcmK8`) ran during the verified OFF_PEAK window, persisted across `opencode reload`, and was then removed through `/offpeak remove`; only the pre-existing retained record from the previous closeout (`da6de0b6-...`) remains in the queue.
- After switching the live configuration to `#v0.1.1`, a further fresh TUI run (`cbb7ee5f`) reconciled 13 plugins with zero failures and `/offpeak status` still worked.

**Known residual state:** PID 2844814 (the pre-fix 2.0.18 TUI) still runs and now logs the explicit compatibility error each time it reconciles the plugin. Host safety rules prohibit terminating active terminal sessions, so it was not restarted. It predates the plugin and will disappear when that terminal session exits; a relaunched TUI uses 2.0.26 and loads the plugin correctly. Unreferenced `git-opencode-offpeak-*` cache directories from earlier installs were left in place; the live installation resolves the tag from `git-opencode-offpeak-8e4083270199`.

## v0.1.0 (historical)

`opencode-offpeak` v0.1.0 is the original release and remains publicly distributable through OpenCode CLI v2's supported Git plugin installation path:

```sh
opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.0
```

The release is at `https://github.com/lutzkind/opencode-offpeak/releases/tag/v0.1.0`. Its tag points to `a77808de7bbb6c91a1460fbc47942ab1d3941814`, and the attached `opencode-offpeak-0.1.0.tgz` has SHA-256 `ac3bb427385f9482a20a86e0024837bf3c3dff620eb11d4aee75d690152633d5`. The exact Git tag install loads both server and TUI entrypoints. npm publication is optional future distribution; npm authentication is not required for normal installation or use, and no user action is required.

The implementation commit at the v0.1.0 release was `2782893c2e09eff6116f77c62b6a4344f92c8224` (`fix: keep v2 entrypoints source-compatible for Git installs`). Release automation was merged to `main` by PR #2 at `89f64a47348025fd63d34fab29c682e9423b5620`; it adds the optional, dormant OIDC workflow and release instructions. A fresh `npm pack` of the package matches the attached v0.1.0 tarball byte-for-byte. No package version or GitHub release needs to change for the supported Git install path.

## 2026-10-11 closeout

- GitHub PR #2 (`ci: add OIDC npm release workflow`) merged as `89f64a47348025fd63d34fab29c682e9423b5620`.
- PR CI run `38112325926` passed on Ubuntu and macOS. Repository standard run `38112325962` passed. A post-merge standard run on `main`, `38112467515`, also passed.
- The account-wide standard reconciler PR #4 removed the repository-specific publish-workflow path filter, restoring the canonical standard workflow. It merged as `c3269c4766502b63693107667abff327842ce4b2`; PR checks `38112742384` (standard) and `38112742392` (Ubuntu/macOS application CI) passed. This did not change package contents or runtime behavior.
- The only remote branch is `main`; the merged `ci/standard-v2.5.2` branch was removed. There are no open PRs or issues.
- The existing GitHub release remains the single `v0.1.0` release. A freshly packed artifact matched its release asset byte-for-byte (SHA-256 `ac3bb427385f9482a20a86e0024837bf3c3dff620eb11d4aee75d690152633d5`).
- At the previous npm audit, the package was absent from npm and no npm identity was authenticated. This is an optional distribution-channel status, not a release blocker.
- `.github/workflows/publish.yml` uses GitHub OIDC without an npm token and now skips by default. It runs only after the repository variable `NPM_TRUSTED_PUBLISHING=enabled` is deliberately set following optional npm bootstrap and trusted-publisher configuration.
- `RELEASING.md` documents the supported Git install as complete and npm bootstrap as optional future work. No account action is needed for the current release.
- Current release artifact clean-install smoke: installed the GitHub release tarball into an empty consumer directory; both `opencode-offpeak/server` and `opencode-offpeak/tui` export plugin objects with callable `setup` functions.
- Fresh OpenCode v2.0.26 smoke after the documentation update: installed the exact `git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.0` specification into an isolated config/cache. Server logs showed the tag-installed `src/server.ts` entrypoint loading; `/offpeak status`, `on`, `off`, `pricing`, `queue`, `list`, and `cancel` worked in the TUI.
- Restart smoke: after turning the plugin OFF and queueing a fixture task, a new OpenCode TUI process restored `DISABLED` and the same queued task ID. It stayed `QUEUED` while disabled and was cancelled after verification. No model request was made during these TUI controls.
- Request guard fixture: a fresh OpenCode `run` through the exact Git tag used a localhost-only provider with a policy blocking the current time. It exited with `PricingBlockedError` before transport; the fixture received zero HTTP requests. No paid provider was contacted.
- Fresh `npm ci` passed with 0 reported vulnerabilities; lint and typecheck passed; all 28 tests passed; `npm pack --dry-run` passed; both package entrypoints loaded from a clean local-tarball consumer.
- `actionlint` passed the new workflow and all workflows when configured to recognize this repository's existing custom self-hosted labels. The agent-friendliness contract passed.

## Repository and compatibility

- Canonical checkout: `/root/opencode-offpeak`
- Default branch: `main`
- Package: `opencode-offpeak@0.1.6`, MIT
- Verified CLI: OpenCode v2.0.26 and v2.0.27
- Declared supported range: `>=2.0.26 <2.1.0`, enforced at startup and declared in `engines.opencode`
- GitHub install after release: `opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.6`
- Package exports OpenCode v2 server and TUI plugins. The TUI registers `/offpeak` and uses OpenCode plugin RPC to control the server-side queue.

## Architecture

One package uses OpenCode v2 request hooks, session APIs, plugin storage, RPC, and background server. Queue metadata is persisted in OpenCode plugin storage. The persistent toggle and policy configuration live in `$OPENCODE_CONFIG_DIR/offpeak.json`, or `$XDG_CONFIG_HOME/opencode/offpeak.json` by default. Task records keep explicit OpenCode session IDs. There is no database, second agent runtime, daemon, remote queue, or telemetry.

The request guard checks HTTP and experimental WebSocket model requests before transport. It fails closed for invalid configuration, invalid pricing data, and unknown models under a configured provider. `OFF` pauses queue automation and keeps the hard guard active; only the explicit task-scoped 15-minute `/offpeak run-now <task-id>` action can authorize peak inference.

Two built-in policies ship (v0.1.6): `deepseek-opencode-go` (provider `opencode-go`) and `deepseek-api` (provider `deepseek`, the direct DeepSeek API), sharing one verified UTC schedule — weekdays 01:00–04:00 and 06:00–10:00 UTC are peak; weekends, the remaining hours, and Chinese statutory public holidays are off-peak — and one shared Chinese holiday calendar. Vendor-documented flat-priced models evaluate `FLAT` (never held); a model with no verified entry fails closed. OpenCode Zen (provider `opencode`) has no time-based pricing at all and therefore no policy: its requests are never delayed. Each policy carries its own source URL and `verifiedAt` date; provider terms can change, so re-verify the sources before updating a policy (see `docs/pricing-policies.md`).

## Implemented behavior

- Persistent `/offpeak on`, `/offpeak off`, `/offpeak status`, `/offpeak pricing`, `/offpeak list`, `/offpeak queue`, `/offpeak cancel`, `/offpeak retry`, `/offpeak resume`, and `/offpeak run-now` controls.
- Sequential queue with FIFO order, task-specific model/policy/working directory, explicit session binding, cancellation, retry, and visible failure state.
- `auto`, `queue`, and `guard` modes; automatic same-session pause/resume in `auto` mode.
- Request-boundary block for peak pricing, including tasks that cross a pricing boundary. Local tools already in flight are allowed to settle.
- Restart recovery: safe waiting tasks resume in their stored session; ambiguous `RUNNING` tasks are preserved as `FAILED` and require explicit retry to avoid duplicate paid inference.
- Timezone-safe policy evaluation, weekday/weekend and overnight windows, DST handling, strict config validation, and fail-closed policy evaluation.
- MIT license, professional public README and docs, contributor/security guidance, CI, and npm package metadata.

## Verification performed

- `npm run check`: lint and typecheck passed; all 28 tests passed, including lifecycle, OFF preservation, same-session resume, request-boundary, override, crash recovery, policy boundary, timezone/DST, and OpenCode v2 registration tests.
- GitHub Actions run `37944688036` passed on both `ubuntu-latest` and `macos-latest` for implementation commit `2782893c2e09eff6116f77c62b6a4344f92c8224`.
- GitHub Actions run `37946282697` passed on both `ubuntu-latest` and `macos-latest` for release commit `a77808de7bbb6c91a1460fbc47942ab1d3941814`.
- `npm pack --dry-run` passed. A clean consumer installed the generated tarball; Node imports confirmed both packaged server and TUI `setup` entrypoints. The artifact contained 41 files (37,375 bytes compressed; 147,140 bytes unpacked).
- A fresh OpenCode CLI v2.0.26 Git install loaded the exact implementation commit. In the TUI, `/offpeak off`, `/offpeak on`, `/offpeak status`, `/offpeak queue`, `/offpeak list`, and `/offpeak cancel` worked. `OFF` persisted across a graceful server restart; the queued task remained queued with its record preserved and was not started while disabled.
- The documented exact-tag Git install completed successfully from GitHub after the docs update. The isolated test config ended with `enabled: false`; the user's configuration was not accessed or changed.
- The local guard fixture returned `requests=0` for the blocked request; no real model key or paid provider was used.
- Lifecycle tests simulate `ON → OFF_PEAK → RUNNING → PEAK → WAITING_OFFPEAK → OFF_PEAK → same session resumed → COMPLETED`, and the OFF/ON pause-preservation sequence. The real TUI smoke covered persistence, queueing while OFF, and no automatic start while OFF; automated tests cover the full boundary/resume lifecycle.
- Current OpenCode v2 plugin API, lifecycle, CLI installation, and Go pricing sources were reviewed. The package was implemented independently; prior queue/scheduler projects are acknowledged as inspirations, with no code copied.
- npm checks at that time returned `ENEEDAUTH` / `E404`. npm publication is optional future distribution and is not required for installation or use.

## Deployment and runtime notes

There is no hosted service deployment. OpenCode owns execution. Its supported background server must be running for unattended work; it can continue after the TUI closes. After a machine restart, start the OpenCode background service or configure the host's supported service manager. This package does not install an OS daemon or scheduler.

The 2026-10-12 repair used OpenCode's supported `opencode reload` on the shared service on port 49374 rather than a process restart, because the shared service hosts active sessions and host safety rules prohibit terminating them. My isolated test service was stopped through `opencode service stop`. A `tui-package` scratch service from an earlier phase is owned by a separate active OpenCode terminal process and was left running.

## Known limitations

- OpenCode compatibility is intentionally limited to the declared v2 range until later versions are tested. Hosts before 2.0.26 fail with the explicit compatibility error; the TUI process must be restarted after `opencode upgrade` to pick up a newer binary.
- WebSocket request hooks are experimental in OpenCode v2.
- A request deferred in `auto` mode lives in the running server process; a plugin/server shutdown fails it closed instead of replaying it, and the persisted deferral delivers one same-session continuation once the allowed window arrives.
- In a shared OpenCode server, plugins load once per workspace, so the in-memory `interactiveWaiting` count is visible only from the instance that holds the request. The hold and release behavior is instance-independent and unaffected.
- A provider request already accepted before a pricing boundary cannot be recalled. A request that passes the pre-model guard just before PEAK begins is still caught by the transport guard, where a hold longer than the 5-minute provider header timeout can time out in that sub-millisecond boundary case.
- After a full server restart, a persisted deferral continues the session when the location is next active (OpenCode boots locations and plugins lazily), so the continuation can lag the boundary until then.
- Ambiguous provider outcomes after a crash are not replayed automatically; delivery is not exactly-once.
- Providers without a configured policy are `UNTRACKED`; this plugin does not guard them until a verified policy is added.
- Machine-boot startup depends on the user's OS service manager.
- npm installation and registry readback are not verified; npm is an optional future distribution channel. Its OIDC workflow remains dormant by default and does not affect GitHub-tag installation.

## User action required

None. The v0.1.6 GitHub release is the complete public distribution path and installs through OpenCode's supported `opencode plugin add` Git specification. The server-side plugin is already reloaded to v0.1.6; a TUI process started before the reload (for example PID 4053968) keeps its older TUI entrypoint until it is relaunched, so relaunch a TUI to see the new `/offpeak status` wording and the hold/resume toasts. Plugin behavior (holding, recovery, notifications on the event stream) is server-side and unaffected by an older TUI process.

## Next normal maintenance

Before changing a built-in pricing schedule or model list, inspect the current OpenCode Go, OpenCode Zen, and DeepSeek API pricing pages plus the OpenCode v2 plugin documentation; update the policy definition(s) and `verifiedAt` dates in `src/policy.ts`, add provider tests, run `npm run check`, build and pack, and verify the supported CLI version range. The Chinese holiday calendar (`src/holidays.ts`) needs one data update per year after the State Council publishes the next arrangement (usually November), and the verified model lists and the Zen flat-pricing fact are re-checked at the same time. Continue distributing GitHub-tag releases through OpenCode's supported Git install path. Only use the optional npm OIDC workflow after the package and trusted-publisher relationship have been bootstrapped and the repository opt-in variable is enabled.
