# Pricing policies

## Policy shape

```json
{
  "id": "example-provider",
  "providers": ["provider-id"],
  "models": ["model-id", "model-family-*"],
  "timeZone": "Europe/Berlin",
  "blocked": [
    { "days": [1, 2, 3, 4, 5], "start": "09:00", "end": "17:00" }
  ],
  "multiplier": 2,
  "source": "https://provider.example/pricing",
  "verifiedAt": "2026-10-09"
}
```

Weekdays are `0` Sunday through `6` Saturday. Windows use local policy time and are start-inclusive/end-exclusive. Windows may cross midnight; their weekday applies to the day on which the window starts. Model patterns support `*` as a wildcard. Do not create ambiguous patterns that match the same provider/model.

The policy includes a source URL and verification date to make schedule provenance reviewable. `multiplier` is status metadata; the guard does not estimate or aggregate bills.

## Built-in policy

`deepseek-opencode-go` matches provider ID `opencode-go` and the DeepSeek model IDs listed in the [README](../README.md). Its canonical schedule is defined only in `src/policy.ts`. It follows the current [OpenCode Go pricing page](https://opencode.ai/docs/go/); it does not assume the separate direct DeepSeek API holiday schedule applies to OpenCode Go.

An unknown model under provider `opencode-go` returns `UNKNOWN` and fails closed. Add a verified model/policy entry before relying on newly added provider models.

## Evaluation and timezones

Pricing is evaluated in the policy's IANA timezone with `Intl.DateTimeFormat`; DST changes and local weekday transitions are evaluated from absolute timestamps. The display timezone is independent. Invalid zones and malformed schedules fail closed.

See `test/policy.test.mjs` for UTC boundaries, DST, weekend transitions, timezone display, and midnight-spanning cases.
