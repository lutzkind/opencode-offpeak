# Handoff

## Current state

Implementation is in progress. The repository is `/root/opencode-offpeak`; the local package is `opencode-offpeak@0.1.0` and targets OpenCode CLI v2.0.26.

## Architecture

One npm package exposes a server plugin and TUI plugin. OpenCode plugin storage holds queue state; OpenCode sessions are the execution context; `~/.config/opencode/offpeak.json` holds the persistent enabled flag, mode, display timezone, and pricing policies. A request-boundary guard fails closed for peak or unknown configured policies. Ambiguous `RUNNING` tasks after restart require explicit retry.

## Implemented so far

- Built-in DeepSeek/OpenCode Go policy and timezone-aware evaluator.
- Persistent ON/OFF settings and task state transitions.
- Sequential queue, same-session task records, cancellation/retry/resume, and explicit expiring override.
- OpenCode v2 server/TUI plugin entrypoints and local RPC.
- Unit/lifecycle tests for toggle, price boundary, timezone/DST, override, retry, and ambiguous restart handling.

## Remaining

- Complete docs, package/install verification, and local OpenCode loader integration.
- Complete public GitHub repository setup, CI, tag/release, and source verification.
- npm publication is not possible until a package-registry identity is authenticated on the host.
- Perform final API/pricing audit, full test/build/package checks, and update this handoff with outcomes.
