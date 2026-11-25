# Concepts

## Two globals, one chat choice

- **CLI Protection** — a persistent global switch for chats opened in the CLI/TUI.
- **Desktop Protection** — an independent persistent global switch for chats opened in Desktop.
- **This chat** — `follow global`, `always protect`, or `allow peak`.

Both globals start ON. A chat without an explicit setting follows the client
that most recently opened it. A chat no client has registered stays protected.

An explicit chat setting wins over either global in both directions:

```text
global OFF + chat “Always protect” → waits at peak
global ON  + chat “Allow peak”     → runs at peak
```

The Desktop settings page and `/offpeak` expose the same state. `/offpeak on`
changes only the surface that ran it; `/offpeak desktop on` (or `cli on`) changes
one named client explicitly.

## Pricing policy

The policy decides whether a provider/model request is `PEAK`, `OFF_PEAK`,
`FLAT`, `UNTRACKED`, or `UNKNOWN` using the configured weekly windows, the
vendor's flat priced model list, and the Chinese statutory holiday calendar.

- `PEAK` — waits when the chat is protected.
- `OFF_PEAK` / `FLAT` — allowed.
- `UNTRACKED` — no policy installed for the provider; allowed.
- `UNKNOWN` — a configured provider with an unmatched model; fail-closed.

Invalid configuration always fails closed. `displayTimeZone` affects only the
status output; the policy timezone moves the boundaries.

## Boundary behavior

The `model.request` hook runs while OpenCode prepares each model request,
before a provider attempt and its response-header timeout exist. A protected
peak request is held there: nothing is sent, and the same session continues the
same turn when off-peak returns. The HTTP/WebSocket transport hooks remain the
final hard barrier immediately before the provider transport.

A request already accepted by the provider cannot be withdrawn. Local tool
operations already running are allowed to settle; the next model request is the
enforcement boundary. If the plugin or server shuts down while a request waits,
it fails closed rather than guessing the price.

## Recovery

A primary held request persists a deferral. If a reload, restart, or OpenCode's
inactivity sweep interrupts it, the plugin continues the same session once at
the next allowed window. A retryable provider/network failure that crosses into
peak is vetoed and recovered the same way. Non-retryable failures keep their
normal outcome.

A lost compaction hold re-admits OpenCode's own compaction (semantic recovery,
not a replay) and keeps it ahead of a prompt that was waiting behind it. A lost
title hold only verifies the title; it never overwrites a rename or generates a
second title.

## Lifecycle authority

OpenCode owns sessions, transcripts, tools, permissions, model selection, and
the background server lifecycle. The plugin stores only pricing policy,
client/chat protection state, and minimal recovery markers.
