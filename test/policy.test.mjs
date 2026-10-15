import assert from "node:assert/strict";
import test from "node:test";
import { DEEPSEEK_OPENCODE_GO, evaluatePricing, formatInTimeZone } from "../dist/policy.js";

const model = "deepseek-v4.1-flash";
const provider = "opencode-go";
const at = (value) => Date.parse(value);
const state = (iso, policies = [DEEPSEEK_OPENCODE_GO]) =>
  evaluatePricing(policies, provider, model, at(iso));

test("DeepSeek Go weekly peak windows use [start, end) boundaries", () => {
  assert.equal(state("2026-10-12T00:59:59Z").state, "OFF_PEAK");
  assert.equal(state("2026-10-12T01:00:00Z").state, "PEAK");
  assert.equal(state("2026-10-12T03:59:59Z").state, "PEAK");
  assert.equal(state("2026-10-12T04:00:00Z").state, "OFF_PEAK");
  assert.equal(state("2026-10-12T05:59:59Z").state, "OFF_PEAK");
  assert.equal(state("2026-10-12T06:00:00Z").state, "PEAK");
  assert.equal(state("2026-10-12T09:59:59Z").state, "PEAK");
  assert.equal(state("2026-10-12T10:00:00Z").state, "OFF_PEAK");
});

test("weekends and Friday-to-Saturday boundaries are off peak", () => {
  assert.equal(state("2026-10-09T23:59:59Z").state, "OFF_PEAK");
  assert.equal(state("2026-10-10T01:00:00Z").state, "OFF_PEAK");
  assert.equal(state("2026-10-11T09:59:59Z").state, "OFF_PEAK");
  assert.equal(state("2026-10-12T00:59:59Z").state, "OFF_PEAK");
});

test("policy timezone is independent of display timezone and converts to UTC", () => {
  assert.equal(state("2026-10-12T08:00:00Z").state, "PEAK");
  assert.match(formatInTimeZone(at("2026-10-12T08:00:00Z"), "Asia/Bangkok"), /3:00 PM/);
  assert.match(formatInTimeZone(at("2026-10-12T08:00:00Z"), "America/Los_Angeles"), /1:00 AM/);
  assert.match(formatInTimeZone(at("2026-10-12T08:00:00Z"), "Europe/Berlin"), /10:00 AM/);
});

test("DST spring gap and repeated fall hour follow IANA wall-clock rules", () => {
  const policy = {
    ...DEEPSEEK_OPENCODE_GO,
    id: "new-york-sunday-test",
    timeZone: "America/New_York",
    blocked: [{ days: [0], start: "01:30", end: "02:30" }],
  };
  const policies = [policy];
  const spring = (iso) => evaluatePricing(policies, provider, model, at(iso));
  assert.equal(spring("2026-03-08T06:29:59Z").state, "OFF_PEAK");
  assert.equal(spring("2026-03-08T06:30:00Z").state, "PEAK");
  assert.equal(spring("2026-03-08T06:59:59Z").state, "PEAK");
  assert.equal(spring("2026-03-08T07:00:00Z").state, "OFF_PEAK");
  assert.equal(spring("2026-11-01T05:45:00Z").state, "PEAK");
  assert.equal(spring("2026-11-01T06:45:00Z").state, "PEAK");
  assert.equal(spring("2026-11-01T07:30:00Z").state, "OFF_PEAK");
});

test("windows spanning midnight attach the after-midnight segment to the start weekday", () => {
  const policy = {
    ...DEEPSEEK_OPENCODE_GO,
    id: "overnight-test",
    timeZone: "UTC",
    blocked: [{ days: [1], start: "22:00", end: "02:00" }],
  };
  const evaluate = (iso) => evaluatePricing([policy], provider, model, at(iso));
  assert.equal(evaluate("2026-10-12T21:59:59Z").state, "OFF_PEAK");
  assert.equal(evaluate("2026-10-12T22:00:00Z").state, "PEAK");
  assert.equal(evaluate("2026-10-13T01:59:59Z").state, "PEAK");
  assert.equal(evaluate("2026-10-13T02:00:00Z").state, "OFF_PEAK");
});

test("next transition points to the exact UTC minute boundary", () => {
  const decision = state("2026-10-12T00:59:59Z");
  assert.equal(decision.nextTransition, at("2026-10-12T01:00:00Z"));
});

test("unknown models for a configured provider fail closed; unrelated providers are untracked", () => {
  const unknownModel = evaluatePricing(
    [DEEPSEEK_OPENCODE_GO],
    provider,
    "deepseek-new-model",
    at("2026-10-12T12:00:00Z"),
  );
  assert.equal(unknownModel.state, "UNKNOWN");
  assert.equal(unknownModel.allowed, false);
  const unrelated = evaluatePricing(
    [DEEPSEEK_OPENCODE_GO],
    "anthropic",
    "claude-sonnet",
    at("2026-10-12T02:00:00Z"),
  );
  assert.equal(unrelated.state, "UNTRACKED");
  assert.equal(unrelated.allowed, true);
});

test("documented flat models have no peak window and stay allowed during DeepSeek peak hours", () => {
  // The Go pricing table lists peak/off-peak tiers only for the DeepSeek models.
  for (const modelID of [
    "gpt-6-luna",
    "gpt-5.6-luna",
    "claude-haiku-5-5",
    "gemini-4-argon-contributor",
    "glm-5.3-flash",
    "glm-5.3",
    "glm-5.2",
    "kimi-k3",
    "kimi-k2.7-code",
    "longcat-2.0",
    "mimo-v2.6-flash",
    "minimax-m3",
    "muse-spark-1.3-contributor",
    "qwen3.8-flash",
    "hy3",
    "space-bunny",
    "step-5-preview-free",
    "cat-jam-free",
    "grok-4.7",
    "longcat-2.5-preview-free",
  ]) {
    const decision = evaluatePricing(
      [DEEPSEEK_OPENCODE_GO],
      provider,
      modelID,
      at("2026-10-12T02:00:00Z"),
    );
    assert.equal(decision.state, "OFF_PEAK", modelID);
    assert.equal(decision.allowed, true, modelID);
    assert.equal(decision.policy?.id, "deepseek-opencode-go", modelID);
    assert.equal(decision.nextTransition, undefined, modelID);
    // The same flat model is never blocked at any hour, including peak edges.
    assert.equal(
      evaluatePricing([DEEPSEEK_OPENCODE_GO], provider, modelID, at("2026-10-12T06:00:00Z")).state,
      "OFF_PEAK",
      modelID,
    );
  }
});

test("the peak-priced DeepSeek models keep their windows next to the flat model list", () => {
  for (const modelID of ["deepseek-v4.1-flash", "deepseek-v4-pro"]) {
    assert.equal(
      evaluatePricing([DEEPSEEK_OPENCODE_GO], provider, modelID, at("2026-10-12T02:00:00Z")).state,
      "PEAK",
      modelID,
    );
    assert.equal(
      evaluatePricing([DEEPSEEK_OPENCODE_GO], provider, modelID, at("2026-10-12T05:00:00Z")).state,
      "OFF_PEAK",
      modelID,
    );
  }
});

test("a model matching both the peak and flat patterns stays peak-priced", () => {
  const policy = {
    ...DEEPSEEK_OPENCODE_GO,
    id: "overlap-test",
    models: ["deepseek-v4.1-flash"],
    flatModels: ["deepseek-*"],
  };
  assert.equal(
    evaluatePricing([policy], provider, "deepseek-v4.1-flash", at("2026-10-12T02:00:00Z")).state,
    "PEAK",
  );
  assert.equal(
    evaluatePricing([policy], provider, "deepseek-other", at("2026-10-12T02:00:00Z")).state,
    "OFF_PEAK",
  );
});

test("a model matching neither list on a configured provider still fails closed", () => {
  const decision = evaluatePricing(
    [DEEPSEEK_OPENCODE_GO],
    provider,
    "future-model-x",
    at("2026-10-12T05:00:00Z"),
  );
  assert.equal(decision.state, "UNKNOWN");
  assert.equal(decision.allowed, false);
});

test("ambiguous flat policies and invalid flat patterns fail closed", () => {
  const ambiguous = [
    { ...DEEPSEEK_OPENCODE_GO, id: "flat-one", flatModels: ["shared-*"] },
    { ...DEEPSEEK_OPENCODE_GO, id: "flat-two", flatModels: ["shared-*"] },
  ];
  const decision = evaluatePricing(
    [...ambiguous],
    provider,
    "shared-model",
    at("2026-10-12T05:00:00Z"),
  );
  assert.equal(decision.state, "UNKNOWN");
  assert.equal(decision.allowed, false);
  const invalid = { ...DEEPSEEK_OPENCODE_GO, id: "bad-flat", flatModels: ["  "] };
  assert.equal(
    evaluatePricing([invalid], provider, "gpt-6-luna", at("2026-10-12T05:00:00Z")).state,
    "UNKNOWN",
  );
});

test("invalid timezone and schedule data fail closed", () => {
  const invalid = {
    ...DEEPSEEK_OPENCODE_GO,
    id: "invalid-zone",
    timeZone: "Mars/Olympus_Mons",
  };
  assert.equal(
    evaluatePricing([invalid], provider, model, at("2026-10-12T12:00:00Z")).allowed,
    false,
  );
  const badWindow = {
    ...DEEPSEEK_OPENCODE_GO,
    id: "invalid-time",
    blocked: [{ days: [1], start: "25:00", end: "26:00" }],
  };
  assert.equal(
    evaluatePricing([badWindow], provider, model, at("2026-10-12T12:00:00Z")).state,
    "UNKNOWN",
  );
});

const dateRange = (start, end) => {
  const dates = [];
  for (
    let day = Date.parse(`${start}T00:00:00Z`);
    day <= Date.parse(`${end}T00:00:00Z`);
    day += 86_400_000
  ) {
    dates.push(new Date(day).toISOString().slice(0, 10));
  }
  return dates;
};

test("Chinese public holidays override weekday peak windows", () => {
  // Same hour, same nominal window: normal Monday, weekend days, and a statutory holiday.
  assert.equal(state("2026-10-12T02:00:00Z").state, "PEAK");
  assert.equal(state("2026-10-10T02:00:00Z").state, "OFF_PEAK");
  assert.equal(state("2026-10-11T02:00:00Z").state, "OFF_PEAK");
  assert.equal(state("2026-10-01T02:00:00Z").state, "OFF_PEAK");
  assert.equal(state("2026-10-01T08:00:00Z").state, "OFF_PEAK");
});

test("every official 2026 holiday period is off-peak all day", () => {
  const periods = [
    ["2026-01-01", "2026-01-03"],
    ["2026-02-15", "2026-02-23"],
    ["2026-04-04", "2026-04-06"],
    ["2026-05-01", "2026-05-05"],
    ["2026-06-19", "2026-06-21"],
    ["2026-09-25", "2026-09-27"],
    ["2026-10-01", "2026-10-07"],
  ];
  for (const [start, end] of periods) {
    for (const date of dateRange(start, end)) {
      // Both nominal weekday PEAK windows must be off-peak on every holiday date.
      assert.equal(state(`${date}T02:00:00Z`).state, "OFF_PEAK", date);
      assert.equal(state(`${date}T08:00:00Z`).state, "OFF_PEAK", date);
    }
  }
});

test("official weekend make-up workdays stay off-peak", () => {
  for (const date of [
    "2026-01-04",
    "2026-02-14",
    "2026-02-28",
    "2026-05-09",
    "2026-09-20",
    "2026-10-10",
  ]) {
    assert.equal(state(`${date}T02:00:00Z`).state, "OFF_PEAK", date);
    assert.equal(state(`${date}T08:00:00Z`).state, "OFF_PEAK", date);
  }
});

test("the days immediately before and after a holiday keep the normal weekly schedule", () => {
  assert.equal(state("2026-04-03T02:00:00Z").state, "PEAK");
  assert.equal(state("2026-04-07T02:00:00Z").state, "PEAK");
  assert.equal(state("2026-09-24T02:00:00Z").state, "PEAK");
  assert.equal(state("2026-09-28T02:00:00Z").state, "PEAK");
  assert.equal(state("2026-09-30T02:00:00Z").state, "PEAK");
  assert.equal(state("2026-10-08T02:00:00Z").state, "PEAK");
});

test("nextTransition skips holiday peak windows and points at the next real peak", () => {
  assert.equal(state("2026-09-30T12:00:00Z").nextTransition, at("2026-10-08T01:00:00Z"));
  assert.equal(state("2026-10-05T02:00:00Z").nextTransition, at("2026-10-08T01:00:00Z"));
  assert.equal(state("2026-10-07T23:59:00Z").nextTransition, at("2026-10-08T01:00:00Z"));
  assert.equal(state("2026-01-01T02:00:00Z").nextTransition, at("2026-01-05T01:00:00Z"));
  // Inside a holiday peak hour the state is off-peak, and the transition is the
  // next real peak after the holiday, not a boundary inside it.
  assert.equal(state("2026-05-04T02:00:00Z").state, "OFF_PEAK");
  assert.equal(state("2026-05-04T02:00:00Z").nextTransition, at("2026-05-06T01:00:00Z"));
});

test("holiday dates follow the calendar time zone, not the host or UTC date", () => {
  const policy = {
    ...DEEPSEEK_OPENCODE_GO,
    id: "holiday-time-zone-test",
    timeZone: "UTC",
    blocked: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "16:00", end: "17:00" }],
    holidays: [
      {
        year: 2026,
        timeZone: "Asia/Shanghai",
        dates: ["2026-10-02"],
        source: "fixture",
      },
    ],
  };
  const evaluate = (iso) => evaluatePricing([policy], provider, model, at(iso));
  // 2026-10-02 starts at 2026-10-01T16:00:00Z in Asia/Shanghai.
  assert.equal(evaluate("2026-10-01T16:00:00Z").state, "OFF_PEAK");
  assert.equal(evaluate("2026-10-01T16:30:00Z").state, "OFF_PEAK");
  // The same UTC hour on the UTC calendar date is not the listed Shanghai date.
  assert.equal(evaluate("2026-10-02T16:00:00Z").state, "PEAK");
  assert.equal(evaluate("2026-10-02T16:30:00Z").state, "PEAK");
  assert.equal(state("2026-10-01T07:00:00Z").state, "OFF_PEAK");
});

test("years without a holiday calendar keep the deterministic weekly schedule", () => {
  const holidays = DEEPSEEK_OPENCODE_GO.holidays ?? [];
  assert.ok(holidays.every((calendar) => calendar.year !== 2027));
  // A Monday in 2027 inside a nominal peak window is still peak; weekends stay off-peak.
  assert.equal(state("2027-01-04T02:00:00Z").state, "PEAK");
  assert.equal(state("2027-01-02T02:00:00Z").state, "OFF_PEAK");
});

test("the built-in China holiday calendar carries its authority metadata", () => {
  const calendar = DEEPSEEK_OPENCODE_GO.holidays?.find((item) => item.year === 2026);
  assert.ok(calendar);
  assert.equal(calendar.timeZone, "Asia/Shanghai");
  assert.match(calendar.source, /^https:\/\/www\.gov\.cn\//);
  assert.equal(typeof calendar.verifiedAt, "string");
  assert.equal(typeof calendar.description, "string");
  assert.equal(new Set(calendar.dates).size, calendar.dates.length);
});

test("invalid holiday calendar data fails closed", () => {
  const base = {
    ...DEEPSEEK_OPENCODE_GO,
    id: "holiday-validation",
    holidays: [DEEPSEEK_OPENCODE_GO.holidays[0]],
  };
  const cases = [
    { ...base, holidays: [{ ...base.holidays[0], dates: ["2026-13-01"] }] },
    { ...base, holidays: [{ ...base.holidays[0], dates: ["2026-02-30"] }] },
    { ...base, holidays: [{ ...base.holidays[0], dates: ["2027-01-01"] }] },
    { ...base, holidays: [{ ...base.holidays[0], dates: ["2026-01-01", "2026-01-01"] }] },
    { ...base, holidays: [{ ...base.holidays[0], source: "" }] },
    { ...base, holidays: [{ ...base.holidays[0], timeZone: "Mars/Olympus_Mons" }] },
    { ...base, holidays: [{ ...base.holidays[0], year: "2026" }] },
  ];
  for (const policy of cases) {
    const decision = evaluatePricing([policy], provider, model, at("2026-10-12T02:00:00Z"));
    assert.equal(decision.state, "UNKNOWN", JSON.stringify(policy.holidays));
    assert.equal(decision.allowed, false);
  }
});

test("an empty holiday list keeps the weekly schedule untouched", () => {
  const policy = { ...DEEPSEEK_OPENCODE_GO, id: "no-holidays", holidays: [] };
  assert.equal(
    evaluatePricing([policy], provider, model, at("2026-10-01T02:00:00Z")).state,
    "PEAK",
  );
  assert.equal(
    evaluatePricing([policy], provider, model, at("2026-10-10T02:00:00Z")).state,
    "OFF_PEAK",
  );
});
