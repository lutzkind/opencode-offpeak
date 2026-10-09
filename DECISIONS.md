# Decisions

## 2026-10-09: Implement independently against OpenCode v2

The package uses the installed OpenCode 2.0.26 plugin API instead of forking a prior queue, scheduler, or legacy peak-guard project. Prior projects were reviewed for scheduling, persistence, and user experience; their code is not included.

## 2026-10-09: One package, server and TUI entrypoints

OpenCode v2 separates server-side plugin hooks from TUI keymap slash commands. Publish one npm package exposing `./server` and `./tui`, bridged by OpenCode's plugin RPC. This retains the requested `/offpeak` UX without a second service.

## 2026-10-09: OpenCode owns session and queue persistence

Queue metadata uses OpenCode's plugin storage. Session IDs are the canonical task execution context. No database or duplicate execution engine is added.

## 2026-10-09: Config file is the canonical persistent toggle

`~/.config/opencode/offpeak.json` stores the enabled flag, mode, display timezone, and policy set. TUI commands atomically update the same file, so configuration and command state cannot silently disagree. OpenCode plugin storage remains the queue store.

## 2026-10-09: Fail closed at request transport boundaries

Use v2 HTTP and experimental WebSocket request hooks immediately before network send. Unknown models under a configured provider, invalid policy data, and unreadable config block the request. An unrelated provider with no policy is explicitly `UNTRACKED`.

## 2026-10-09: OFF is passive automation, not a price override

OFF stops queue starts and auto-resumes, preserves task/session records, and leaves peak requests blocked. Only a visible, expiring, task-scoped `run-now` action grants peak inference.

## 2026-10-09: Same-session pause and resume

Tasks store the OpenCode session ID. At a peak boundary, an `auto` task waits at its next provider request and continues the same session after the configured allowed window returns.

## 2026-10-09: No exact-once claim after a crash

OpenCode documents recovery as at-least-once. A persisted `RUNNING` task with a non-success session outcome is ambiguous. Mark it `FAILED`, preserve the session, and require explicit retry rather than risking a duplicated paid inference. Safe `WAITING_OFFPEAK` tasks continue automatically.

## 2026-10-09: No external wake helper in v0.1

OpenCode's supported background server keeps plugin timers and sessions available after the TUI closes. If the server is stopped, tasks remain durable and resume on server startup. Machine boot startup is delegated to a user's OS service manager; this package does not add a daemon or install host service configuration.

## 2026-10-09: Built-in schedule follows OpenCode Go

The policy matches current OpenCode Go billing windows, which list weekdays in UTC and a 2x peak price/allowance multiplier for these DeepSeek models. It does not substitute direct DeepSeek API holiday terms for OpenCode Go pricing.
