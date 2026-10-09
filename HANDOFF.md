# Handoff — 2026-10-09

## Release status

`opencode-offpeak@0.1.0` is implemented and release-ready for GitHub. The public GitHub repository is `https://github.com/lutzkind/opencode-offpeak`. npm publication remains blocked because this host has no authenticated npm identity (`npm whoami` returns `ENEEDAUTH`); the package is not yet present in the registry. Do not describe the npm package as published until registry readback succeeds.

The implementation commit at final audit was `2782893c2e09eff6116f77c62b6a4344f92c8224` (`fix: keep v2 entrypoints source-compatible for Git installs`). This handoff update is a documentation-only closeout; the `v0.1.0` GitHub tag/release is to point at the final closeout commit after its CI run passes.

## Repository and compatibility

- Canonical checkout: `/root/opencode-offpeak`
- Default branch: `main`
- Package: `opencode-offpeak@0.1.0`, MIT
- Verified CLI: OpenCode v2.0.26
- Declared supported range: `>=2.0.26 <2.1.0`
- GitHub install after release: `opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.0`
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
- GitHub Actions run `37944688036` passed on both `ubuntu-latest` and `macos-latest` for implementation commit `2782893c2e09eff6116f77c62b6a4344f92c8224`. The final documentation-only commit must also pass CI before tagging.
- `npm pack --dry-run` passed. A clean consumer installed the generated tarball; Node imports confirmed both packaged server and TUI `setup` entrypoints. The artifact contained 41 files (37,375 bytes compressed; 147,140 bytes unpacked).
- A fresh OpenCode CLI v2.0.26 Git install loaded the exact implementation commit. In the TUI, `/offpeak off`, `/offpeak on`, `/offpeak status`, `/offpeak queue`, `/offpeak list`, and `/offpeak cancel` worked. `OFF` persisted across a graceful server restart; the queued task remained queued with its record preserved and was not started while disabled.
- Against a localhost-only OpenAI-compatible fixture using that exact Git-installed commit, an interactive request blocked by policy exited with code 1 and made zero fixture requests. An allowed request completed with `fixture-ok`; the fixture observed the provider transport calls. No real model key or paid provider was used.
- Lifecycle tests simulate `ON → OFF_PEAK → RUNNING → PEAK → WAITING_OFFPEAK → OFF_PEAK → same session resumed → COMPLETED`, and the OFF/ON pause-preservation sequence. The real TUI smoke covered persistence, queueing while OFF, and no automatic start while OFF; automated tests cover the full boundary/resume lifecycle.
- Current OpenCode v2 plugin API, lifecycle, CLI installation, and Go pricing sources were reviewed. The package was implemented independently; prior queue/scheduler projects are acknowledged as inspirations, with no code copied.
- npm checks: `npm whoami` returns `ENEEDAUTH`; `npm view opencode-offpeak version` returns 404. This is the only outstanding publication blocker.

## Deployment and runtime notes

There is no hosted service deployment. OpenCode owns execution. Its supported background server must be running for unattended work; it can continue after the TUI closes. After a machine restart, start the OpenCode background service or configure the host's supported service manager. This package does not install an OS daemon or scheduler.

Task-scoped test services were stopped through `opencode service stop` after confirming no active sessions. The shared OpenCode service on port 49374 was left untouched. A `tui-package` scratch service is owned by a separate active OpenCode terminal process and was left running.

## Known limitations

- OpenCode compatibility is intentionally limited to the declared v2 range until later versions are tested.
- WebSocket request hooks are experimental in OpenCode v2.
- A provider request already accepted before a pricing boundary cannot be recalled.
- Ambiguous provider outcomes after a crash are not replayed automatically; delivery is not exactly-once.
- Providers without a configured policy are `UNTRACKED`; this plugin does not guard them until a verified policy is added.
- Machine-boot startup depends on the user's OS service manager.
- npm installation and registry readback are not verified because registry authentication is unavailable.

## Remaining external step

Authenticate an authorized npm publisher, publish the reviewed `0.1.0` package, then verify `npm view opencode-offpeak version`, install it from the registry in a clean OpenCode config, and read back plugin loading. Do not make a second version or republish until the package name and registry state are checked.

## Next normal maintenance

Before changing the built-in pricing schedule or model list, inspect the current OpenCode Go pricing page and OpenCode v2 plugin documentation, update the single policy definition and verification date, run `npm run check`, build and pack, verify the supported CLI version range, and publish a new pre-1.0 version only after a registry-authenticated release check.
