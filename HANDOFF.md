# Handoff — 2026-10-13

## Release status

`opencode-offpeak` v0.1.3 is the canonical release:

```sh
opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.3
```

- Release: `https://github.com/lutzkind/opencode-offpeak/releases/tag/v0.1.3`
- Tag commit: `38c8cb250c48c50aecd972eff64840e1f68d0cfa` (merge of PR #8)
- Fix commit: `a626e09f381b2a354d2fe55b9df43134db83ec14`
- Attached `opencode-offpeak-0.1.3.tgz` SHA-256: `edfeb739be653ee2aebd6d5e7e456cdc7dc42793e6b6bdce24052548a59e5ff1` (matches `npm pack` from the tag commit)
- The `v0.1.0`, `v0.1.1`, and `v0.1.2` tags were not mutated and remain installable.

The live environment installs the exact tag: `/root/.config/opencode/opencode.json` contains `git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.3`, `/api/plugin` reports `version 38c8cb250c48c50aecd972eff64840e1f68d0cfa` with server and TUI features active, and the live server loads `src/server.ts` from the tag cache.

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
- Package: `opencode-offpeak@0.1.2`, MIT
- Verified CLI: OpenCode v2.0.26 and v2.0.27
- Declared supported range: `>=2.0.26 <2.1.0`, enforced at startup and declared in `engines.opencode`
- GitHub install after release: `opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.3`
- Package exports OpenCode v2 server and TUI plugins. The TUI registers `/offpeak` and uses OpenCode plugin RPC to control the server-side queue.

## Architecture

One package uses OpenCode v2 request hooks, session APIs, plugin storage, RPC, and background server. Queue metadata is persisted in OpenCode plugin storage. The persistent toggle and policy configuration live in `$OPENCODE_CONFIG_DIR/offpeak.json`, or `$XDG_CONFIG_HOME/opencode/offpeak.json` by default. Task records keep explicit OpenCode session IDs. There is no database, second agent runtime, daemon, remote queue, or telemetry.

The request guard checks HTTP and experimental WebSocket model requests before transport. It fails closed for invalid configuration, invalid pricing data, and unknown models under a configured provider. `OFF` pauses queue automation and keeps the hard guard active; only the explicit task-scoped 15-minute `/offpeak run-now <task-id>` action can authorize peak inference.

The built-in `deepseek-opencode-go` policy matches the OpenCode Go provider and its listed DeepSeek models. Its single canonical UTC schedule was checked against the official OpenCode Go pricing page on 2026-10-09: weekdays 01:00–04:00 and 06:00–10:00 are peak; weekends and the remaining hours are off-peak. OpenCode Go lists peak token rates at twice the off-peak rates. Provider terms can change; re-verify the source before updating the policy.

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
- An interactive request held in `auto` mode lives in the running server process; a plugin/server shutdown fails it closed instead of replaying it.
- In a shared OpenCode server, plugins load once per workspace, so the in-memory `interactiveWaiting` count is visible only from the instance that holds the request. The hold and release behavior is instance-independent and unaffected.
- A provider request already accepted before a pricing boundary cannot be recalled.
- Ambiguous provider outcomes after a crash are not replayed automatically; delivery is not exactly-once.
- Providers without a configured policy are `UNTRACKED`; this plugin does not guard them until a verified policy is added.
- Machine-boot startup depends on the user's OS service manager.
- npm installation and registry readback are not verified; npm is an optional future distribution channel. Its OIDC workflow remains dormant by default and does not affect GitHub-tag installation.

## User action required

None. The v0.1.2 GitHub release is the complete public distribution path and installs through OpenCode's supported `opencode plugin add` Git specification. If a terminal still runs a TUI started before an `opencode upgrade`, exit and relaunch it so the TUI executes the supported version; the plugin reports that condition explicitly.

## Next normal maintenance

Before changing the built-in pricing schedule or model list, inspect the current OpenCode Go pricing page and OpenCode v2 plugin documentation, update the single policy definition and verification date, run `npm run check`, build and pack, and verify the supported CLI version range. Continue distributing GitHub-tag releases through OpenCode's supported Git install path. Only use the optional npm OIDC workflow after the package and trusted-publisher relationship have been bootstrapped and the repository opt-in variable is enabled.
