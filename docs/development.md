# Development

## Requirements

- Node.js 22 or newer for the TypeScript/build/test toolchain.
- OpenCode CLI `>=2.0.26 <2.5.0` for runtime integration.
- OpenCode Desktop 2.3.0+ for GUI runtime integration.
- npm for install/build/pack checks.

The build dependency is `@opencode/plugin@2.4.0`, the SDK of the newest validated host; the Desktop GUI SDK and its Vite preset exist from 2.3.0. The declared runtime range remains the tested server/TUI range `>=2.0.26 <2.5.0`; the hooks, RPC, storage, and TUI surfaces used by those entrypoints are unchanged from 2.0.26, and the packed plugin is still smoke-tested on the minimum host. The GUI entrypoint is one prebuilt CommonJS bundle; the server and TUI entrypoints continue to load from TypeScript source in Git installs.

## Commands

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm pack --dry-run
```

`npm test` compiles TypeScript, builds `dist/gui-experimental.cjs` with Vite, and runs Node's built-in test runner with files serialized (`--test-concurrency=1`). The real fixture and TUI tests use real time and CPU; running them beside the deterministic timer tests starves the latter on a loaded host. Serial execution keeps the suite reliable without weakening any assertion. Pricing and queue tests use deterministic timestamps, fake sessions, and local temporary storage. Boundary-wait tests additionally use a manual clock whose timers fire only when the test advances time, proving releases come from the scheduled pricing transition. They do not make provider requests or require API credentials.

The GUI bundle is built from `src/gui.tsx` by the official `@opencode/plugin/gui/vite` preset (`vite.config.ts`). It must remain one CommonJS file with only the app-provided shared modules external. `test/gui.test.mjs` loads the actual packaged bundle and exercises its setup with fake GUI contexts; it proves that registration, settings, slash commands, and hold/resume toasts target the routed session's server rather than the Desktop sidecar, and that real/untitled/renamed session labels come from the canonical desktop data store. A real Desktop runtime is not available on this host, so Desktop end-to-end behavior is validated through the installed 2.4.0 GUI SDK, the shared RPC contract, and the packaged bundle, not a live Electron window.

The suite includes a real OpenCode v2 TUI smoke test (`test/tui-smoke.test.mjs`) and a real TUI client test (`test/tui-client.test.mjs`). When the `opencode` CLI and `tmux` are on `PATH`, it packs the repository, loads the packed package into an isolated OpenCode configuration with `--standalone`, asserts the plugin reconciliation has no `Keymap.Provider is missing` failure, and drives `/offpeak status` in the live TUI. Without those prerequisites the test skips; set `OPENCODE_OFFPEAK_OPENCODE_BIN` to point at a specific OpenCode binary. The smoke test never contacts a model provider and never touches the user's OpenCode configuration.

## Package layout

- `src/server.ts`: package root/server plugin and session hooks.
- `src/commands.ts`: the single `/offpeak` grammar and output implementation shared by the TUI and Desktop.
- `src/tui.ts`: `./tui` v2 slash-command entrypoint, CLI session registration, and RPC client.
- `src/gui.tsx` and `src/gui/`: `./gui-experimental` Desktop entrypoint, native settings page, composer slash command, hold/resume toasts, real session-title resolution, and server-targeting helpers.
- `src/compat.ts`: tested OpenCode range and the startup compatibility guard.
- `src/engine.ts`: queue state machine, scheduler, request guard, and restart reconciliation.
- `src/policy.ts`: generic pricing-policy type and the single built-in schedule definition.
- `src/config.ts`: validated persistent config.
- `src/store.ts`: versioned queue, session-override, and client-default/ownership persistence plus synchronization primitives.
- `src/rpc.ts`: portable JSON-schema RPC contract shared by the server, TUI, and GUI.
- `src/gui/connection.ts`: pure server-selection and RPC helpers used by the GUI bundle and its tests.
- `src/gui/settings.tsx`: native Solid settings page with the two-level Desktop/chat controls.

The repository includes both Bun-loadable TypeScript entrypoints and the compiled `dist/` output used by Node-based package checks. Git installs load the TypeScript sources through the `bun` export condition; npm tarballs include both forms.

Do not add test-only production hooks or contact a real paid model from automated tests.
