# Configuration

## Default path and format

The setting file is `$OPENCODE_CONFIG_DIR/offpeak.json` when `OPENCODE_CONFIG_DIR` is set. Otherwise it is `$XDG_CONFIG_HOME/opencode/offpeak.json`, or `~/.config/opencode/offpeak.json` when `XDG_CONFIG_HOME` is unset. `OPENCODE_OFFPEAK_CONFIG` can override the file path. The first toggle command creates it atomically with owner-only permissions.

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "mode": "auto",
  "displayTimeZone": "Asia/Bangkok"
}
```

If `policies` is omitted, the built-in DeepSeek/OpenCode Go policy is used. If you provide `policies`, treat the array as the full active policy set and include the built-in entry too if you still want DeepSeek Go protection. An empty array is invalid. Do not configure overlapping policies for the same provider/model. A stored policy that is otherwise identical to a built-in policy (same id, providers, models, time zone, multiplier, and weekly windows) adopts the built-in holiday calendar automatically, so yearly holiday updates apply without editing the file; any customized difference — including an explicit `holidays` list — is preserved exactly.

## Fields

- `schemaVersion`: must be `1`.
- `enabled`: boolean, default `true`. `/offpeak on|off` updates this same value.
- `mode`: `auto` (default), `queue`, or `guard`. In `auto`, normal interactive peak requests are deferred at OpenCode's pre-model hook and released when off-peak returns; `queue` and `guard` block interactive peak requests immediately at the transport guard.
- `displayTimeZone`: valid IANA timezone for status output; defaults to the system timezone.
- `policies`: complete list of pricing policy definitions. See [pricing policies](pricing-policies.md).

`/offpeak session on|off` does not write this file. Session-scoped off-peak protection is stored as an explicit per-session override in OpenCode plugin storage (key `opencode-offpeak/session-overrides-v1`); the default for every session is ON, and absence of an entry means protection is on. The override is deliberately not part of `offpeak.json` because it belongs to one interactive session, not to the installation: it survives reloads and restarts with the session, is removed when the session is deleted, and never changes global settings. While a session's protection is off it may dispatch verified peak-priced work at peak rates (see the README section); `UNKNOWN` models and invalid configuration still fail closed for it.

The policy timezone is authoritative for pricing. Changing `displayTimeZone` does not move a pricing boundary. The running server watches the config file and reloads settings after atomic updates.

## Invalid configuration

Malformed JSON, unsupported schema versions, invalid IANA timezones, overlapping policy matches, or malformed schedule windows fail closed for matching provider requests. Queue processing stops if the config cannot be loaded. Fix the file and save it; the server watches for the change. A config error is shown by `/offpeak status`.

The plugin does not read provider credentials from this file. Keep API keys in OpenCode's supported auth store.
