# Architecture

`opencode-offpeak` is one npm package with three OpenCode v2 entrypoints:

- `./server` owns pricing evaluation, request holds, recovery, client globals,
  per-chat settings, and OpenCode plugin-storage state. It is the single
  authority for every pricing decision.
- `./tui` registers `/offpeak`, registers the routed CLI chat's origin through
  typed RPC, and renders hold/resume toasts.
- `./gui-experimental` is the Desktop GUI entrypoint (`src/gui.tsx` → one
  prebuilt `dist/gui-experimental.cjs`). It contributes the native settings page,
  the same `/offpeak` command as a composer slash command, a session-registration
  effect, and hold/resume toasts. It calls the selected chat server's typed RPC
  and never initializes the server engine.

There is no installation-wide enable switch, no execution mode, no background
task queue, no daemon, database, scheduler, or provider proxy. OpenCode owns
sessions, model/provider selection, permissions, tools, transcript, and project
context.

## User model

Two persistent client globals and one per-chat setting:

| State | Effect |
|---|---|
| CLI global `ON` | CLI chats wait for off-peak unless a chat overrides |
| Desktop global `ON` | Desktop chats wait for off-peak unless a chat overrides |
| Chat `follow global` | follows the client that most recently opened the chat |
| Chat `always protect` | waits at peak even when its client global is `OFF` |
| Chat `allow peak` | runs at verified peak prices even when its global is `ON` |

Defaults are `ON` for both clients and `follow global` for every chat. A chat
no client has registered stays protected (fail-closed). Invalid configuration
and `UNKNOWN` pricing always fail closed, including for an `allow peak` chat.

## Client identification

The server's request hooks expose the session ID but no client identity, so
each client extension observes the chat through its supported lifecycle API and
registers that observation with the server that owns the chat:

- TUI: `context.client.rpc(...)` registers the routed/active session as `cli`.
- GUI: the selected session's `SessionRef.server.client` registers it as `desktop`.

Registration is idempotent and additive. The most recent client becomes the
chat's `owner`; opening an existing chat in the other client updates the owner,
so the switch in the client the user is actually using takes effect. An explicit
per-chat setting is unaffected by ownership.

## Request path

The server registers `model.request`, `http.request`,
`experimental.ws.handshake`, `experimental.ws.send`, and `retry`.

1. `model.request` runs while OpenCode prepares every model request (primary,
   compaction, title, generate), before any provider attempt exists.
2. The plugin evaluates the configured pricing policy with its stored clock and
   timezone.
3. `UNTRACKED` providers pass. `UNKNOWN` models throw a fail-closed
   `PricingBlockedError`. `OFF_PEAK` and `FLAT` pass. `PEAK` passes only when the
   chat's effective protection is `OFF`.
4. Otherwise the request is held. No provider traffic is sent. A primary request
   emits one hold notification; auxiliary title/compaction/generate holds are
   silent.
5. The hold re-evaluates on the shared signal, on the policy's next transition,
   and when any global or chat setting changes. If protection becomes `OFF` or
   pricing becomes allowed, the same request continues in the same session.
6. The transport hooks remain the final hard barrier immediately before an HTTP
   request or WebSocket frame. They re-check the same decision and fail closed.

A primary pre-model hold persists a `deferred` recovery marker. If the plugin
reloads or the server restarts, the marker is delivered as one same-session
continuation at the allowed window. A lost compaction hold persists a
`pending-compaction` marker and re-admits OpenCode's own compaction; a lost title
hold persists a `pending-title` marker and only verifies the title, never
overwrites it. A user cancel clears pending work; an inactivity or shutdown
interrupt keeps it.

A retryable provider/network failure that crosses into peak is vetoed
(`decision.retry = false`) and recorded as a `retry-failure` recovery instead of
retrying into the provider. Non-retryable failures keep OpenCode's normal
outcome. A chat with effective protection `OFF` keeps OpenCode's normal retry
behavior.

## Held-request cancellation

`cancelHold { sessionID }` lets a caller that owns a routing decision cancel a
parked request without interrupting the session. The hold settles once:
`committed` (dispatch won), `refused` (cancellation won), or `none`. A refused
request is replaced at the transport boundary with a credential-free placeholder
aimed at a closed loopback endpoint carrying only the marker header
`x-opencode-offpeak-refused`; OpenCode sees a retryable transport failure and its
own retry policy decides what happens next. The refusal is not treated as a
provider failure, so the plugin does not register its own continuation for it.

`pricing { providerID, modelID }` is the read-only canonical classification for
other plugins (for example `opencode-free-first` `peak-only`). It has no queue,
hold, timer, or persistence side effect.

## State and persistence

- `offpeak.json` — pricing policy only: `schemaVersion`, `displayTimeZone`, and
  optional `policies`. `enabled` and `mode` from v0.4.x are accepted and ignored.
- `opencode-offpeak/clients-v1` — `defaults {cli, desktop}` and per-chat
  `{clients, owner, updatedAt}`.
- `opencode-offpeak/session-overrides-v1` — explicit per-chat `on`/`off` only.
  Absence means follow-global.
- `opencode-offpeak/recovery-v1` — same-session recovery markers, scoped by
  plugin location.
- `opencode-offpeak/queue-v1` — legacy v0.4.x queue records. Not read, executed,
  or deleted by v0.5.0.

All documents are versioned JSON in OpenCode plugin storage. Client writes read
the latest document under a process-wide lock and apply only their own delta, so
a stale OpenCode location cannot revert another location's newer setting. Reads
happen before every protection decision; a read failure falls back to both
globals `ON`, unknown ownership, and refused writes (fail-closed).

`session.deleted` removes a chat's ownership and override. Bounded lazy cleanup
on start-up and explicit chat commands reaps only sessions that a supported
`session.get` reports as confidently missing; a transient error keeps state.

## Compatibility

`package.json` declares `engines.opencode >=2.0.26 <2.5.0`. Both entrypoints
check `context.app.version` at setup and refuse an unsupported host with an
explicit error. The range has been validated at 2.0.26, 2.0.27, 2.0.30, 2.1.3,
2.2.6, 2.3.0, 2.3.2, 2.4.0, and 2.4.1.

OpenCode 2.3 added plugin surfaces and deprecated `generate`; OpenCode 2.3.1
enabled background compaction by default; 2.3.2 changed only
`experimental.generate` and prompt caching; 2.4 added background jobs, video,
automations, GUI icons, and composer delivery modes. None of those changed
`model.request`, `http.request`, the experimental WebSocket hooks, `retry`,
session events, storage, RPC, or `context.keymap.layer()`. The Desktop GUI SDK
exists from 2.3.0; the GUI entrypoint is built against 2.4.1.

## Testing contract

Tests use fixtures and a deterministic mock provider; they never incur provider
charges or provoke a real free-tier limit. The suite covers policy evaluation,
client globals, last-opener ownership, per-chat overrides in both directions,
holds and releases, retry recovery, compaction/title recovery, cancellation,
persistence, the packaged GUI bundle, and a packed real-TUI fixture run.
