# Concepts

## Three separate controls

- **Enabled toggle:** decides whether the queue starts and auto-resumes tasks. It persists across OpenCode restarts.
- **Pricing policy:** decides whether a request for a provider/model is off-peak, peak, untracked, or unknown.
- **Override:** explicit permission for one task to make peak-priced model requests until its 15-minute expiry.

Turning the plugin OFF changes only automation. It does not change pricing evaluation or create an override.

## Modes

`auto` starts and resumes queued tasks when policy allows, and defers normal interactive peak requests until off-peak returns. `queue` starts queued tasks when allowed but waits for a manual `/offpeak resume` after a peak pause, and blocks interactive peak requests immediately. `guard` enforces interactive model requests without automatically starting queued tasks or deferring interactive requests for a later window.

## Boundary behavior

Pricing is enforced at two lifecycle points. A `model.request` hook runs while OpenCode prepares each model request, before the provider attempt and its response-header timeout exist. In `auto` mode a peak-priced request is deferred there: nothing is sent while pricing is blocked, and the same session continues the same turn when off-peak returns. The HTTP/WebSocket transport guard still runs immediately before the provider transport as the final hard barrier, and `queue`/`guard`/OFF requests are blocked there exactly as before. A request already accepted by the provider cannot be withdrawn. Local tool operations already running are allowed to settle; the next paid model request is the enforcement boundary.

In `auto` mode, an interactive message sent during peak pricing is deferred before the provider attempt and continues automatically when off-peak returns; no second message is needed, and no provider attempt or response-header timer is held open. The release comes from the scheduled pricing transition (or a config change), never from another message, a status command, or a manual wake-up. `queue`/`guard` modes and the OFF state block interactive peak requests immediately, and a plugin shutdown fails a deferred request closed rather than sending it. If OpenCode's own location-activity sweep ends a deferred session (60 minutes with no durable session events), the plugin records the persisted recovery described below.

A request that is already in flight and fails with a retryable provider/network error (for example a header timeout) after peak pricing begins is recovered the same way. The plugin stops OpenCode's retry before it can reach the provider, then continues the same session at the next off-peak transition with a short continuation prompt: a queue task returns to `WAITING_OFFPEAK`, and an interactive session is reported under `Recovery` in `/offpeak status`. Non-retryable failures and failures while pricing is allowed keep their normal OpenCode behavior.

## Lifecycle authority

OpenCode owns session transcripts, session IDs, tools, permissions, model selection, and background server lifecycle. This plugin stores only task metadata and never selects an implicit global “last session.”
