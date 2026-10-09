# Queue and task lifecycle

## Queue a task

Select a provider/model in OpenCode, then:

```text
/offpeak queue Implement the missing test for the config parser.
```

Queueing stores the prompt, project working directory, current provider/model, policy ID, task ID, and queue timestamps. It does not immediately call the model. The task gets an OpenCode session when the scheduler can start it.

## Task states

- `QUEUED`: waiting for an eligible pricing window or for the plugin to be enabled.
- `RUNNING`: attached to a session that is actively processing.
- `WAITING_OFFPEAK`: same task/session is paused at the request boundary or awaiting an allowed window.
- `COMPLETED`: OpenCode reports the stored session outcome as succeeded.
- `FAILED`: session failure, invalid task policy, or ambiguous crash recovery; inspect `lastError` and explicitly retry.
- `CANCELLED`: user explicitly cancelled the task. The session ID remains available in task history.

## Inspect and control

```text
/offpeak list
/offpeak status
/offpeak cancel <task-id>
/offpeak retry <task-id>
/offpeak resume <task-id>
```

`retry` continues the stored session after an explicit user action. In `queue` mode, `resume` requests continuation of a waiting task. Pricing checks still apply in both cases.

## Peak override

```text
/offpeak run-now <task-id>
```

This is a separate, explicit 15-minute override for one task. It requires the plugin to be ON, is displayed in status, expires automatically, and does not affect other queued tasks. It can consume peak-priced OpenCode Go allowance.

## Ordering and concurrency

Tasks are processed sequentially. The oldest eligible task runs first. A waiting task in `auto` mode is resumed before later queued work so the plugin does not start another task concurrently with its held session. No task is deleted automatically.
