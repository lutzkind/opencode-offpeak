# Pricing policies

## Policy shape

```json
{
  "id": "example-provider",
  "providers": ["provider-id"],
  "models": ["model-id", "model-family-*"],
  "flatModels": ["flat-model-id", "flat-family-*"],
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

`models` are the peak-priced models: they are `PEAK` inside a blocked window and `OFF_PEAK` outside it. `flatModels` are the provider's models with a single all-hours price documented by the provider: they evaluate `FLAT` at every hour (allowed, no transition) and are never held or blocked. A pattern that matches both lists is treated as peak-priced (`models` wins). A model that matches neither list is `UNKNOWN` and fails closed. Both lists come from the provider's own pricing page; cite it in `source` and record the date in `verifiedAt`. Prefer explicit model IDs and family globs over a blanket `*`: a future model with new time-based pricing must fail closed, not inherit an old schedule.

The policy includes a source URL and verification date to make schedule provenance reviewable. `multiplier` is status metadata; the guard does not estimate or aggregate bills.

## Built-in policies

Two policies ship built in, both with the same verified weekly windows (`DEEPSEEK_PEAK_WINDOWS` in `src/policy.ts`) and the same shared holiday calendar data (`CHINA_PUBLIC_HOLIDAYS` in `src/holidays.ts`):

- `deepseek-opencode-go` — provider ID `opencode-go` (OpenCode Go).
- `deepseek-api` — provider ID `deepseek` (the direct DeepSeek API).

Their canonical schedules are defined only in `src/policy.ts`. When a stored `offpeak.json` contains only unmodified copies of the shipped policies, a newly shipped built-in policy is appended at read time, so existing installations gain it without editing the file; a customized policy set is authoritative and is never modified.

### OpenCode Go (`opencode-go`)

The rules are: peak Monday–Friday 01:00–04:00 and 06:00–10:00 UTC for the DeepSeek models; off-peak all other hours, weekends, and Chinese statutory public holidays in full; weekend make-up working days stay off-peak because weekends are always off-peak.

The [Go pricing table](https://opencode.ai/docs/go/) lists peak/off-peak tiers only for the DeepSeek models. Every other documented Go model has one all-hours price, so the built-in `flatModels` list mirrors that table (GPT 6/5.6 Luna, Claude Haiku 5.5, Gemini 4 Argon Contributor, GLM, Kimi, LongCat, MiMo, MiniMax, Muse Spark, Qwen, Hy, Space Bunny, Step 5 Preview Free, Cat Jam Free, Grok). This matters in practice because OpenCode generates automatic session titles with the provider's *small* model (`model.small`), which for `opencode-go` is `gpt-6-luna`; without the flat entry that auxiliary request would be `UNKNOWN` and a title could never be generated. A stored copy of the built-in policy that predates `flatModels` adopts the built-in list at read time when it is otherwise unmodified.

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

A listed date overrides every weekday peak window for the whole calendar day in the calendar's own time zone. The built-in 2026 calendar comes from the official State Council notice; `nextTransition` skips holiday peak windows; a year without a calendar keeps the deterministic weekly schedule, and no future dates are guessed. The State Council publishes the next year's arrangement each November, so the calendar needs one data update per year. The rule follows the DeepSeek pricing documentation referenced by the OpenCode Go pricing page; upstream [anomalyco/opencode#53071](https://github.com/anomalyco/opencode/issues/53071) tracks an open report about National Day billing and is the cue for the annual re-check. The annual review also re-checks the `flatModels` list against the Go pricing table: a newly added model that is not listed becomes `UNKNOWN` and fails closed until the policy is updated.

An unknown model under provider `opencode-go` returns `UNKNOWN` and fails closed. Add a verified model/policy entry before relying on newly added provider models.

### Direct DeepSeek API (`deepseek`)

The [DeepSeek pricing documentation](https://api-docs.deepseek.com/quick_start/pricing) lists the two canonical API models `deepseek-flash` (DeepSeek-V4.1-Flash) and `deepseek-v4-pro` (DeepSeek-V4-Pro-0813), each with Off-Peak and Peak token rates ("Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays. All other hours are off-peak, including weekends and Chinese public holidays in full."). The same page notes that the legacy names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still accepted, served by DeepSeek-V4.1-Flash and billed at the Flash price, so they share the schedule and are listed explicitly. The policy matches exactly these four IDs — there is no `deepseek-*` wildcard, and a future direct model fails closed until it is verified.

OpenCode exposes provider ID `deepseek` (package `@opencode/ai/providers/deepseek`, base URL `https://api.deepseek.com`) with exactly the two canonical models in its live registry; the legacy aliases are kept for sessions pinned to an older catalog and for API-level use.

### OpenCode Zen (`opencode`) — no policy by design

The [OpenCode Zen pricing page](https://opencode.ai/docs/zen/) lists one all-hours price (input, output, cached read/write) per model. There are no peak/off-peak tiers and no holiday rule, so there is nothing to wait for: the plugin deliberately installs **no** policy for provider `opencode` and never delays or blocks a Zen request. This is the smallest correct representation — "this provider currently has no relevant time-based pricing rule" — and it means a new Zen model is never blocked merely because a DeepSeek policy exists for another provider. The verified fact (name, note, source URL, verification date) lives in `VERIFIED_FLAT_PROVIDERS` in `src/policy.ts` and is surfaced by `/offpeak status` as `Pricing: UNTRACKED` with `Requests: ALLOWED (no policy needed: …)`. If Zen ever introduces time-based tiers, add a policy with the verified IDs then.

## Evaluation and timezones

Pricing is evaluated in the policy's IANA timezone with `Intl.DateTimeFormat`; DST changes and local weekday transitions are evaluated from absolute timestamps. The display timezone is independent. Invalid zones and malformed schedules fail closed.

See `test/policy.test.mjs` for UTC boundaries, DST, weekend transitions, timezone display, and midnight-spanning cases.
