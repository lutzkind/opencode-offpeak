# Handoff — 2026-10-12

## Release status

`opencode-offpeak` v0.1.1 is the canonical repaired release:

```sh
opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.1
```

- Release: `https://github.com/lutzkind/opencode-offpeak/releases/tag/v0.1.1`
- Tag commit: `764d1ab4b095a17813d0f63d6fdf0d92e8a1d248` (merge of PR #6)
- Repair commit: `5e9fa10df2178937153500b4984bb1278bf9ca51`
- Attached `opencode-offpeak-0.1.1.tgz` SHA-256: `36a3b14a1f22be656d5838b2edc2aa7d3a8d9208f457b48d9c5bb589d14a0495` (matches `npm pack` from the tag commit)
- The `v0.1.0` tag was not mutated. `v0.1.0` remains installable from its own tag.

The live environment installs the exact tag: `/root/.config/opencode/opencode.json` contains `git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.1`, `/api/plugin` reports `version 764d1ab4b095a17813d0f63d6fdf0d92e8a1d248` with server and TUI features active, and the live server loads `src/server.ts` from the tag cache.

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
- Package: `opencode-offpeak@0.1.1`, MIT
- Verified CLI: OpenCode v2.0.26
- Declared supported range: `>=2.0.26 <2.1.0`, enforced at startup and declared in `engines.opencode`
- GitHub install after release: `opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.1`
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
- A provider request already accepted before a pricing boundary cannot be recalled.
- Ambiguous provider outcomes after a crash are not replayed automatically; delivery is not exactly-once.
- Providers without a configured policy are `UNTRACKED`; this plugin does not guard them until a verified policy is added.
- Machine-boot startup depends on the user's OS service manager.
- npm installation and registry readback are not verified; npm is an optional future distribution channel. Its OIDC workflow remains dormant by default and does not affect GitHub-tag installation.

## User action required

None. The v0.1.1 GitHub release is the complete public distribution path and installs through OpenCode's supported `opencode plugin add` Git specification. If a terminal still runs a TUI started before an `opencode upgrade`, exit and relaunch it so the TUI executes the supported version; the plugin now reports that condition explicitly.

## Next normal maintenance

Before changing the built-in pricing schedule or model list, inspect the current OpenCode Go pricing page and OpenCode v2 plugin documentation, update the single policy definition and verification date, run `npm run check`, build and pack, and verify the supported CLI version range. Continue distributing GitHub-tag releases through OpenCode's supported Git install path. Only use the optional npm OIDC workflow after the package and trusted-publisher relationship have been bootstrapped and the repository opt-in variable is enabled.
