# Configuration

v0.5.0 has two kinds of state: pricing policy (one JSON file) and protection
switches (OpenCode plugin storage).

## Pricing policy file

`$OPENCODE_CONFIG_DIR/offpeak.json` when `OPENCODE_CONFIG_DIR` is set.
Otherwise `$XDG_CONFIG_HOME/opencode/offpeak.json`, or
`~/.config/opencode/offpeak.json` when `XDG_CONFIG_HOME` is unset.
`OPENCODE_OFFPEAK_CONFIG` can override the path.

```json
{
  "schemaVersion": 1,
  "displayTimeZone": "Asia/Bangkok"
}
```

- `schemaVersion`: must be `1`.
- `displayTimeZone`: valid IANA timezone for status output; defaults to the
  system timezone. It does not move a pricing boundary.
- `policies`: optional complete list of pricing policy definitions. If omitted,
  the built-in DeepSeek/OpenCode Go and DeepSeek API policies are used. An
  empty array is invalid. Do not configure overlapping policies for the same
  provider/model. See [pricing policies](pricing-policies.md).

`enabled` and `mode` from v0.4.x are accepted and ignored so an existing file
loads unchanged. They no longer exist as settings: protection is controlled by
the CLI/Desktop switches and the per-chat setting below.

The running server watches the config file and reloads it after an atomic
update. Malformed JSON, unsupported schema versions, invalid timezones,
overlapping policies, or malformed windows fail closed for matching requests.

## Client globals

Each client has one persistent default, both start `ON`:

- `defaults.cli`
- `defaults.desktop`

They are stored in the versioned OpenCode plugin-storage document
`opencode-offpeak/clients-v1`:

```json
{
  "schemaVersion": 1,
  "defaults": { "cli": "on", "desktop": "on" },
  "sessions": {
    "ses_example": {
      "clients": ["cli", "desktop"],
      "owner": "desktop",
      "updatedAt": "2026-11-25T00:00:00.000Z"
    }
  }
}
```

`owner` is the client that most recently opened the chat. A chat without an
explicit per-chat setting follows that client's global, so the switch in the
client the user is actually using takes effect. Registration is idempotent and
survives restarts; the entry is removed when the chat is deleted.

Change a global with `/offpeak on|off` (calling surface), `/offpeak cli on|off`,
`/offpeak desktop on|off`, or the two switches on the Desktop settings page. A
client command never writes the other client.

## Per-chat setting

Stored separately in `opencode-offpeak/session-overrides-v1`:

```json
{
  "schemaVersion": 1,
  "sessions": {
    "ses_example": { "protection": "on", "updatedAt": "2026-11-25T00:00:00.000Z" }
  }
}
```

- `protection: "on"` — always protect this chat, even while its client global is off.
- `protection: "off"` — allow verified peak pricing in this chat, even while its client global is on.
- Absent — follow the client that owns the chat.

Set it with `/offpeak chat on|off|auto`, the hidden `/offpeak session on|off`
alias, or the Desktop page's **Off-peak protection** selector. The setting
applies to one interactive chat only. It never authorizes an `UNKNOWN` model or
invalid configuration, and it is removed when the chat is deleted.

## Precedence

1. Invalid configuration and `UNKNOWN` pricing fail closed.
2. An explicit per-chat setting wins over any client global.
3. Otherwise the most recent client that opened the chat supplies its global.
4. A chat no client registered is protected (`ON`).

## Migration from v0.4.x

- `offpeak.json` `enabled`/`mode` are ignored; `/offpeak on|off` now changes the
  calling client's global instead of pausing automation.
- v0.4.x `session-overrides-v1` entries with `"protection": "off"` keep their
  meaning (allow peak). `"on"` entries are now also stored.
- A stored chat opened by both clients (`ambiguous: true`) is migrated to
  `owner` = the last client in its registration list. An explicit per-chat
  setting still wins.
- Queue records (`opencode-offpeak/queue-v1`) are left untouched but are no
  longer read or executed; the queue feature was removed in v0.5.0.
