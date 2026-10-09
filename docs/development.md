# Development

## Requirements

- Node.js 22 or newer for the TypeScript/build/test toolchain.
- OpenCode CLI `>=2.0.26 <2.1.0` for runtime integration.
- npm for install/build/pack checks.

The plugin API dependency is pinned to `@opencode/plugin@2.0.26`, matching the minimum supported CLI version. OpenCode's generic plugin documentation still describes its older hook API, so changes to the v2 package/runtime are treated as compatibility changes and must be verified against the installed v2 CLI.

## Commands

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm pack --dry-run
```

`npm test` compiles TypeScript and runs Node's built-in test runner. Pricing and queue tests use deterministic timestamps, fake sessions, and local temporary storage. They do not make provider requests or require API credentials.

## Package layout

- `src/server.ts`: package root/server plugin and session hooks.
- `src/tui.ts`: `./tui` v2 slash-command entrypoint and RPC client.
- `src/engine.ts`: queue state machine, scheduler, request guard, and restart reconciliation.
- `src/policy.ts`: generic pricing-policy type and the single built-in schedule definition.
- `src/config.ts`: validated persistent config.
- `src/store.ts`: versioned queue persistence and synchronization primitives.
- `src/rpc.ts`: portable JSON-schema RPC contract shared by the server and TUI.

The repository includes both Bun-loadable TypeScript entrypoints and the compiled `dist/` output used by Node-based package checks. Git installs load the TypeScript sources through the `bun` export condition; npm tarballs include both forms.

Do not add test-only production hooks or contact a real paid model from automated tests.
