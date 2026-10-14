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

`deepseek-opencode-go` matches provider ID `opencode-go` and the DeepSeek model IDs listed in the [README](../README.md). Its canonical schedule is defined only in `src/policy.ts`, with the holiday calendar in `src/holidays.ts`.

The rules are: peak Monday–Friday 01:00–04:00 and 06:00–10:00 UTC; off-peak all other hours, weekends, and Chinese statutory public holidays in full; weekend make-up working days stay off-peak because weekends are always off-peak.

Holiday support uses explicit full-day OFF_PEAK exception calendars on the policy:

```json
{
  "year": 2026,
  "timeZone": "Asia/Shanghai",
  "dates": ["2026-10-01", "2026-10-02"],
  "source": "https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html",
  "verifiedAt": "2026-10-14",
  "description": "Chinese statutory public holidays; State Council notice"
}
```

A listed date overrides every weekday peak window for the whole calendar day in the calendar's own time zone. The built-in 2026 calendar comes from the official State Council notice; `nextTransition` skips holiday peak windows; a year without a calendar keeps the deterministic weekly schedule, and no future dates are guessed. The State Council publishes the next year's arrangement each November, so the calendar needs one data update per year. The rule follows the DeepSeek pricing documentation referenced by the OpenCode Go pricing page; upstream [anomalyco/opencode#53071](https://github.com/anomalyco/opencode/issues/53071) tracks an open report about National Day billing and is the cue for the annual re-check.

An unknown model under provider `opencode-go` returns `UNKNOWN` and fails closed. Add a verified model/policy entry before relying on newly added provider models.

## Evaluation and timezones

Pricing is evaluated in the policy's IANA timezone with `Intl.DateTimeFormat`; DST changes and local weekday transitions are evaluated from absolute timestamps. The display timezone is independent. Invalid zones and malformed schedules fail closed.

See `test/policy.test.mjs` for UTC boundaries, DST, weekend transitions, timezone display, and midnight-spanning cases.
