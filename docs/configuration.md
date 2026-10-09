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

If `policies` is omitted, the built-in DeepSeek/OpenCode Go policy is used. If you provide `policies`, treat the array as the full active policy set and include the built-in entry too if you still want DeepSeek Go protection. An empty array is invalid. Do not configure overlapping policies for the same provider/model.

## Fields

- `schemaVersion`: must be `1`.
- `enabled`: boolean, default `true`. `/offpeak on|off` updates this same value.
- `mode`: `auto` (default), `queue`, or `guard`.
- `displayTimeZone`: valid IANA timezone for status output; defaults to the system timezone.
- `policies`: complete list of pricing policy definitions. See [pricing policies](pricing-policies.md).

The policy timezone is authoritative for pricing. Changing `displayTimeZone` does not move a pricing boundary. The running server watches the config file and reloads settings after atomic updates.

## Invalid configuration

Malformed JSON, unsupported schema versions, invalid IANA timezones, overlapping policy matches, or malformed schedule windows fail closed for matching provider requests. Queue processing stops if the config cannot be loaded. Fix the file and save it; the server watches for the change. A config error is shown by `/offpeak status`.

The plugin does not read provider credentials from this file. Keep API keys in OpenCode's supported auth store.
