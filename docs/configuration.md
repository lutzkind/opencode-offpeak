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

`/offpeak protection chat on|off` (and the legacy `/offpeak session on|off` alias) does not write this file. Chat-scoped off-peak protection is stored as an explicit per-session override in OpenCode plugin storage (key `opencode-offpeak/session-overrides-v1`); the default for every chat is to follow its interface global default, and absence of an entry means no bypass. The Desktop settings page writes the same override through **Protection for this chat**, with the same precedence and the same immediate release of a waiting request. The override is deliberately not part of `offpeak.json` because it belongs to one interactive session, not to the installation: it survives reloads and restarts with the session, is removed when the session is deleted, and never changes global settings. While a session's protection is off it may dispatch verified peak-priced work at peak rates (see the README section); `UNKNOWN` models and invalid configuration still fail closed for it.

The policy timezone is authoritative for pricing. Changing `displayTimeZone` does not move a pricing boundary. The running server watches the config file and reloads settings after atomic updates.

## Client defaults and ownership

`/offpeak protection global on|off` writes only the calling interface's field: `defaults.cli` in the CLI and `defaults.desktop` in Desktop. `/offpeak client` reads both defaults, and the legacy `/offpeak client cli|desktop on|off` forms remain explicit per-client aliases. Both are stored in the versioned OpenCode plugin-storage document `opencode-offpeak/clients-v1`, not in `offpeak.json`:

```json
{
  "schemaVersion": 1,
  "defaults": { "cli": "on", "desktop": "on" },
  "sessions": {
    "ses_example": {
      "clients": ["cli"],
      "ambiguous": false,
      "updatedAt": "2026-11-17T00:00:00.000Z"
    }
  }
}
```

The document is created on the first change. When it is absent, both defaults are ON and no session is registered, which is the safe migration path for existing installations. A session registered by both clients has `clients: ["cli", "desktop"]` and `ambiguous: true`; it remains protected even when one default is OFF. A session with no entry is `UNKNOWN` and remains protected. Queue-owned sessions never inherit a client default.

The Desktop settings page exposes **Desktop Protection** and the current chat's **Protection for this chat** switch. The override is the same `session-overrides-v1` entry that `/offpeak protection chat off` writes; the page never writes `defaults.cli`.

The document is not editable through `offpeak.json` and does not contain prompts, credentials, or provider responses. `session.deleted` removes the entry; bounded lazy cleanup removes only sessions that a supported `session.get` reports as confidently missing. There is no heartbeat or expiry.

## Precedence

1. Invalid configuration and `UNKNOWN` pricing fail closed.
2. An explicit `/offpeak protection chat off` overrides every global default for that one chat.
3. A chat registered by exactly one client uses that interface's global default.
4. A queue-owned session uses the task rules and never a global or chat default.
5. An unregistered (`UNKNOWN`) or shared (`ambiguous`) session stays protected.

`/offpeak on|off` remains global automation and queue processing; it is not a client setting and does not change either default.

## Invalid configuration

Malformed JSON, unsupported schema versions, invalid IANA timezones, overlapping policy matches, or malformed schedule windows fail closed for matching provider requests. Queue processing stops if the config cannot be loaded. Fix the file and save it; the server watches for the change. A config error is shown by `/offpeak status`.

The plugin does not read provider credentials from this file. Keep API keys in OpenCode's supported auth store.
