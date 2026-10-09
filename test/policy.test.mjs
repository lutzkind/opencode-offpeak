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
