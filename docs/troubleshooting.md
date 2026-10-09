# Troubleshooting

## `/offpeak` is not recognized

Confirm the installed CLI is within `>=2.0.26 <2.1.0`, install with `opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.0`, then restart OpenCode. Check `opencode plugin list` and the OpenCode server logs. The server entrypoint provides RPC while the TUI entrypoint registers the slash command.

## Queue does not start

Run `/offpeak status` and `/offpeak list`. Confirm the plugin is ON, `mode` is not `guard`, the selected model has a matching policy, and the OpenCode background server is running. Queued tasks remain in storage while disabled or in a peak window.

## Model request blocked

Check status for `PEAK`, `UNKNOWN`, or `UNTRACKED`. `UNKNOWN` for a configured provider usually means a new model ID or invalid policy/config. Fix the policy using current provider pricing sources. Do not disable the plugin as a price override.

If you intentionally accept peak pricing for a queued task, turn the plugin ON and use `/offpeak run-now <task-id>`. The override expires after 15 minutes.

## Task is waiting

`WAITING_OFFPEAK` preserves the task and session. In `auto` mode, it resumes when both the plugin is ON and the selected policy allows requests. In `queue` mode, run `/offpeak resume <task-id>`; it still waits for an allowed window.

## Task is FAILED after restart

OpenCode session crash recovery is at-least-once. To avoid duplicate paid inference, the plugin does not replay an ambiguous `RUNNING` task automatically. Inspect the OpenCode session, then explicitly run `/offpeak retry <task-id>` if you want to continue it.

## Terminal closed or machine restarted

The OpenCode background server can continue after the TUI terminal closes. Use `opencode service status`. After machine reboot, start the service again or arrange for your OS service manager to run the supported OpenCode `serve` command. The plugin itself does not install a daemon or OS service.

## Config error

The config file path is printed by `/offpeak status`. Fix JSON syntax, schema version, policy fields, or IANA timezones. The server reloads saved changes; if the file remains unreadable, all matching requests stay blocked.
