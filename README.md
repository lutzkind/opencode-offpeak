# opencode-offpeak

Hold peak-priced OpenCode model requests until off-peak pricing starts, then
continue the **same request in the same chat** automatically. Nothing is sent
to the provider while a request waits.

The product surface is deliberately small:

- **CLI Protection** — one persistent global switch for CLI chats.
- **Desktop Protection** — one independent persistent global switch for Desktop chats.
- **This chat** — an optional override: *follow the global*, *always protect*, or *allow peak*.
  An explicit chat setting wins over either global, in both directions.

```text
CLI ON   · Desktop ON   · chat follows global      → peak requests wait
CLI OFF  · Desktop OFF  · chat “Always protect”    → that chat still waits
CLI ON   · Desktop OFF  · chat “Allow peak”        → that chat runs at peak
```

There is no installation-wide enable switch, no `queue`/`guard` mode, and no
background task queue. A chat that is waiting continues when off-peak starts;
that is the only automation.

## Install

```sh
opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.5.1
```

Restart OpenCode after installation. The plugin is enabled with both client
switches ON and the built-in DeepSeek/OpenCode Go policy.

### Desktop GUI

The Desktop application loads its GUI from **Desktop's own**
`opencode.json(c)`, not from the remote server's configuration. Keep the
server package installed where the sessions run, and list the same tag in
Desktop's local config:

```jsonc
{
  "plugins": ["git+https://github.com/lutzkind/opencode-offpeak.git#v0.5.1"]
}
```

Open **Settings > Offpeak**. The page has two global switches and one
per-chat choice; it follows the chat you were viewing before Settings opened.
The same `/offpeak` slash command is available in the Desktop composer.

Desktop 2.3.0 or newer is required for the GUI entrypoint.

## Use it

```text
/offpeak                    status
/offpeak on                 CLI protection ON
/offpeak off                CLI protection OFF
/offpeak chat on            this chat: always protect
/offpeak chat off           this chat: allow verified peak pricing
/offpeak chat auto          this chat: follow its client global
/offpeak cli on|off         CLI global explicitly
/offpeak desktop on|off     Desktop global explicitly
```

Changes apply immediately. Turning a global or a chat off releases a request
that is already waiting, and turning it back on protects the next request.
`/offpeak chat off` never changes a global, and a client command never changes
the other client.

The v0.4.x `protection …`, `client …`, and `session …` forms remain hidden
aliases over the same state; they are not advertised.

## What happens at peak

A supported request that reaches verified peak pricing waits at OpenCode's
pre-model lifecycle hook, before any provider attempt exists. Nothing is sent.
At the next off-peak boundary the same session continues the same turn, with
no second prompt and no replayed tool call. The transport guard remains the
final hard barrier immediately before an HTTP request or WebSocket frame.

A retryable provider/network failure that crosses into peak is also held
instead of retried into the provider. Compaction and automatic-title requests
are covered; a lost compaction or title hold is recovered semantically (the
plugin asks OpenCode to compact again, or lets OpenCode name the session on
the resumed input) rather than replaying a request.

`UNKNOWN` prices (a model with no matching verified policy) and invalid
configuration always fail closed, even for a chat set to **Allow peak**.
Providers documented as flat-priced are allowed at all hours.

## Configuration

`$OPENCODE_CONFIG_DIR/offpeak.json` (or `~/.config/opencode/offpeak.json`,
overridable with `OPENCODE_OFFPEAK_CONFIG`) holds **pricing policy only**:

```json
{
  "schemaVersion": 1,
  "displayTimeZone": "Asia/Bangkok"
}
```

If `policies` is omitted, the built-in DeepSeek/OpenCode Go and DeepSeek API
policies are used. The policy timezone is authoritative; `displayTimeZone`
only affects status output.

Client switches live in OpenCode plugin storage (`opencode-offpeak/clients-v1`)
and per-chat settings in `opencode-offpeak/session-overrides-v1`. They survive
reloads and restarts, and are removed when the chat is deleted.

Legacy `enabled` and `mode` fields in `offpeak.json` are accepted and ignored
during migration so an existing file keeps working without an edit.

## Precedence

1. Invalid configuration and `UNKNOWN` pricing fail closed.
2. An explicit **This chat** setting wins over any client global.
3. Otherwise the chat follows the client that most recently opened it.
4. A chat no client has registered is protected.

## Compatibility

OpenCode CLI `>=2.0.26 <2.5.0`; validated through **2.4.2**. The Desktop GUI
entrypoint requires Desktop 2.3.0+ and is validated against the 2.4.1 GUI SDK.
Both entrypoints refuse to initialize on an unsupported host with a clear
error instead of failing later.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm pack --dry-run
```

Tests use fixtures and a deterministic mock provider; they never incur
provider charges or provoke a real free-tier limit. See
[docs/development.md](docs/development.md) and [RELEASING.md](RELEASING.md).

## License

MIT
