# Concepts

## Three separate controls

- **Enabled toggle:** decides whether the queue starts and auto-resumes tasks. It persists across OpenCode restarts.
- **Pricing policy:** decides whether a request for a provider/model is off-peak, peak, untracked, or unknown.
- **Override:** explicit permission for one task to make peak-priced model requests until its 15-minute expiry.

Turning the plugin OFF changes only automation. It does not change pricing evaluation or create an override.

## Modes

`auto` starts and resumes queued tasks when policy allows. `queue` starts queued tasks when allowed but waits for a manual `/offpeak resume` after a peak pause. `guard` enforces interactive model requests and does not automatically start queued tasks.

## Boundary behavior

The plugin checks immediately before OpenCode's provider HTTP/WebSocket transport. A request already accepted by the provider cannot be withdrawn. Local tool operations already running are allowed to settle; the next paid model request is the enforcement boundary.

## Lifecycle authority

OpenCode owns session transcripts, session IDs, tools, permissions, model selection, and background server lifecycle. This plugin stores only task metadata and never selects an implicit global “last session.”
