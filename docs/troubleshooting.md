# Troubleshooting

## `/offpeak` is not recognized

Confirm the installed CLI is within `>=2.0.26 <2.1.0`, install with `opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.5`, then restart OpenCode. Check `opencode plugin list` and the OpenCode server logs. The server entrypoint provides RPC while the TUI entrypoint registers the slash command.

## `Keymap.Provider is missing` in the TUI

This error means the TUI process is running an OpenCode build older than 2.0.26. Those releases activate TUI plugins outside the keymap provider owner, so `context.keymap.layer()` cannot register `/offpeak`. It is a host-version problem, not a plugin setting: there is no keymap provider to configure. Update OpenCode with `opencode upgrade` and restart the TUI process (a long-running TUI keeps its old code until it restarts). Current releases of this plugin check the host version at startup and report an explicit compatibility error instead.

## Queue does not start

Run `/offpeak status` and `/offpeak list`. Confirm the plugin is ON, `mode` is not `guard`, the selected model has a matching policy, and the OpenCode background server is running. Queued tasks remain in storage while disabled or in a peak window.

## Model request blocked

Check status for `PEAK`, `UNKNOWN`, or `UNTRACKED`. `UNKNOWN` for a configured provider usually means a new model ID or invalid policy/config. Fix the policy using current provider pricing sources. Do not disable the plugin as a price override.

If you intentionally accept peak pricing for a queued task, turn the plugin ON and use `/offpeak run-now <task-id>`. The override expires after 15 minutes.

## Interactive message waits at peak

In `auto` mode, a supported interactive request sent during a peak window is deferred at OpenCode's pre-model hook — before any provider attempt (and its response-header timeout) starts — instead of being discarded or timing out, and the same session proceeds automatically when off-peak returns; no second message is needed. `/offpeak status` shows it under `Interactive` while it waits. In `queue` or `guard` mode, and while the plugin is OFF, interactive peak requests are blocked immediately by the transport guard. If a deferred request fails closed because the plugin or server shut down, resend it after the server is back.

## Request timed out during peak and the session continued later

If a request was already in flight when peak pricing began and failed with a retryable provider/network error such as `Timed out waiting for response headers`, that failure is real — the request had already been sent. In `auto` mode the plugin vetoes OpenCode's retry before it can reach the provider and continues the same session at the next off-peak transition with a short continuation prompt. `/offpeak status` reports `Recovery: N session(s) waiting for off-peak` for interactive sessions, and queue tasks show as `WAITING_OFFPEAK` instead of `FAILED`. No action is needed; the session resumes automatically when pricing allows. If OpenCode itself ends a waiting session (its 60-minute location-activity sweep), the same recovery applies. Non-retryable errors (for example invalid requests or authentication failures) still require you to fix the cause and retry explicitly.

## Task is waiting

`WAITING_OFFPEAK` preserves the task and session. In `auto` mode, it resumes when both the plugin is ON and the selected policy allows requests. In `queue` mode, run `/offpeak resume <task-id>`; it still waits for an allowed window.

## Task is FAILED after restart

OpenCode session crash recovery is at-least-once. To avoid duplicate paid inference, the plugin does not replay an ambiguous `RUNNING` task automatically. Inspect the OpenCode session, then explicitly run `/offpeak retry <task-id>` if you want to continue it.

## Terminal closed or machine restarted

The OpenCode background server can continue after the TUI terminal closes. Use `opencode service status`. After machine reboot, start the service again or arrange for your OS service manager to run the supported OpenCode `serve` command. The plugin itself does not install a daemon or OS service.

## Config error

The config file path is printed by `/offpeak status`. Fix JSON syntax, schema version, policy fields, or IANA timezones. The server reloads saved changes; if the file remains unreadable, all matching requests stay blocked.
