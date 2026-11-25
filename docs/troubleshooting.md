# Troubleshooting

## `/offpeak` is not recognized

Confirm the installed CLI is within `>=2.0.26 <2.5.0`, install with
`opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.5.0`,
then restart OpenCode. Check `opencode plugin list` and the server logs.

OpenCode 2.4 loads plugins asynchronously again, so a TUI opened moments ago can
paint the prompt before its plugins have registered. If `/offpeak` is not
recognized in the first seconds after launch, wait for plugin reconciliation and
type it again; no restart is needed.

## `opencode-offpeak requires OpenCode ...` after an upgrade

The plugin refused to initialize because the host is outside the verified range.
If the host is newer than the ceiling, update `opencode-offpeak` to a release that
lists the host version, or run an OpenCode release inside the supported range.
Do not run `opencode upgrade` again.

## Desktop settings page does not appear

Desktop loads its GUI from **Desktop's own** global `opencode.json(c)`, not from
the remote server's configuration and not from `cli.json`. Add the package there:

```jsonc
{
  "plugins": ["git+https://github.com/lutzkind/opencode-offpeak.git#v0.5.0"]
}
```

Desktop must be 2.3.0 or newer. A server-part load failure also removes the GUI.
Installing the package only on the remote server keeps enforcement there but
does not create the local page.

## Desktop says the server is unavailable

The page talks to the selected chat's actual server. Confirm the remote server
is running, Desktop shows it as connected, and `OPENCODE_SERVER_PASSWORD`
matches. The page shows the RPC error and offers **Retry**; a freshly started
Desktop SSH server can take a few seconds to register the plugin, and the page
retries briefly before showing the error.

## Desktop Protection is OFF but a chat still waits

Check **This chat** on the same page. An explicit **Always protect** setting
wins over the global. Set it to **Follow Desktop global** (or **Allow peak**).
A chat that no client has registered yet is also protected; opening the chat
registers it.

## CLI and Desktop disagree about a chat

A chat follows the client that most recently opened it. Opening it in the other
client updates the owner. An explicit **This chat** setting is independent of
ownership and wins over both globals.

## A chat is set to Allow peak but still waits

`UNKNOWN` models and invalid configuration always fail closed. Check
`/offpeak status`:

- `UNKNOWN` usually means a new model ID or an invalid policy.
- A config error is printed with the file path.

Fix the policy using current provider pricing. There is no global override.

## A message waits at peak

That is protection working. The request is held before any provider traffic and
continues automatically when off-peak starts; no second message is needed.
`/offpeak status` shows the number of waiting requests. To run this chat now,
set **This chat** to **Allow peak** (or run `/offpeak chat off`). That setting
persists until changed.

The TUI keeps its normal "working" indicator while the request is held because
OpenCode exposes no waiting state. The hold toast and `/offpeak status` are the
authoritative signals.

## Manual compaction during peak

A compact-first workflow waits in order: compaction first, then the prompt
behind it. If the compaction hold is lost (reload, restart, inactivity sweep),
the plugin admits OpenCode's own compaction again at the next safe point.
`/offpeak status` reports `Compaction recovery` while that is pending. A
compaction you cancel does not come back.

## A request was refused at the transport boundary

A plugin cancelled a parked request because the routing decision changed. The
request was replaced by a credential-free placeholder aimed at a closed loopback
endpoint, so OpenCode treats the attempt as a retryable transport failure and
retries it on the new route. Nothing was sent to a provider. If the caller does
not retry, the step is reported normally.

## A request timed out during peak and the session continued later

The in-flight request had already been sent and its failure was real. The plugin
vetoes OpenCode's retry into the provider and continues the same session at the
next off-peak window with a short continuation prompt. `/offpeak status` shows
`Recovery` while it waits. Non-retryable errors (invalid request, auth) still
need an explicit fix and retry.

## Config error

The status output prints the config path. Fix JSON syntax, schema version,
policy fields, or IANA timezones. The server reloads saved changes; while the
file is unreadable, matching requests stay blocked.
