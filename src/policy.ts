import { CHINA_PUBLIC_HOLIDAYS, type HolidayCalendar } from "./holidays.js";

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface WeeklyWindow {
  /** ISO-style weekday number, with Sunday = 0. */
  days: Weekday[];
  start: string;
  end: string;
}

export interface PricingPolicy {
  id: string;
  providers: string[];
  /**
   * Patterns for models this policy prices with the weekly `blocked` windows:
   * they are PEAK inside a window and OFF_PEAK outside it.
   */
  models: string[];
  timeZone: string;
  blocked: WeeklyWindow[];
  /**
   * Patterns for models of the same provider with no peak pricing at all: a
   * single all-hours rate documented by the provider. They evaluate as `FLAT`
   * at every hour and are allowed without waiting. A model that matches both
   * `models` and `flatModels` is treated as peak-priced (`models` wins).
   *
   * These are vendor facts, not an assumption: they mirror the provider's own
   * pricing page for the exact model IDs it lists at `verifiedAt`. A model
   * matching neither list stays UNKNOWN and fails closed.
   */
  flatModels?: string[];
  /**
   * Full-day OFF_PEAK exception calendars, for example statutory public
   * holidays. A date listed in a calendar overrides every weekly PEAK window
   * for that whole calendar day in the calendar's time zone.
   */
  holidays?: HolidayCalendar[];
  multiplier?: number;
  source: string;
  verifiedAt?: string;
}

export interface PolicyDecision {
  /**
   * - `PEAK`: inside a verified peak window; requests wait (auto) or block.
   * - `OFF_PEAK`: outside every peak window; requests are allowed now.
   * - `FLAT`: the model has a single vendor-documented all-hours price and no
   *   peak window at all; requests are allowed and never wait.
   * - `UNTRACKED`: no policy covers this provider; the plugin does not guard it.
   * - `UNKNOWN`: the provider is configured but this model has no verified
   *   pricing policy; requests fail closed.
   */
  state: "OFF_PEAK" | "PEAK" | "FLAT" | "UNTRACKED" | "UNKNOWN";
  allowed: boolean;
  policy?: PricingPolicy;
  nextTransition?: number;
  reason?: string;
}

// DeepSeek's official pricing documentation states the peak windows and the
// holiday rule: "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday
// through Friday, excluding Chinese public holidays. All other hours are
// off-peak, including weekends and Chinese public holidays in full."
// (https://api-docs.deepseek.com/quick_start/pricing). The OpenCode Go pricing
// page documents the same windows for the Go gateway
// (https://opencode.ai/docs/go/), and DeepSeek's direct API uses the same
// schedule. Holiday dates come from the State Council calendar in
// src/holidays.ts and are shared by both policies.
const DEEPSEEK_PEAK_WINDOWS: WeeklyWindow[] = [
  { days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" },
  { days: [1, 2, 3, 4, 5], start: "06:00", end: "10:00" },
];

// The Go pricing table lists Off-Peak/Peak tiers only for the DeepSeek models.
// Every other model in the Go catalog has one all-hours price per token, so
// `flatModels` mirrors that table exactly (model IDs from the documented Go
// endpoints list): GPT 6/5.6 Luna, Claude Haiku 5.5, Gemini 4 Argon
// Contributor, GLM, Kimi, LongCat, MiMo, MiniMax, Muse Spark, Qwen, Hy,
// Space Bunny, Step 5 Preview Free, Cat Jam Free, Grok. The layouts are
// deliberately explicit instead of a wildcard so that an unlisted model
// (including a future model with new peak pricing) still fails closed.
export const DEEPSEEK_OPENCODE_GO: PricingPolicy = {
  id: "deepseek-opencode-go",
  providers: ["opencode-go"],
  models: [
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
  ],
  flatModels: [
    "grok-*",
    "gpt-*",
    "claude-*",
    "gemini-*",
    "glm-*",
    "kimi-*",
    "longcat-*",
    "mimo-*",
    "minimax-*",
    "muse-*",
    "qwen*",
    "hy*",
    "space-bunny",
    "step-*",
    "cat-jam-free",
  ],
  timeZone: "UTC",
  blocked: DEEPSEEK_PEAK_WINDOWS,
  holidays: CHINA_PUBLIC_HOLIDAYS,
  multiplier: 2,
  source: "https://opencode.ai/docs/go/",
  verifiedAt: "2026-10-15",
};

// The direct DeepSeek API (OpenCode provider id `deepseek`,
// https://api.deepseek.com) publishes the same weekly windows and holiday rule
// as the Go gateway: "Off-peak rates are half of the peak rates. Peak hours are
// 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding
// Chinese public holidays. All other hours are off-peak, including weekends and
// Chinese public holidays in full."
//
// The canonical API model names are `deepseek-flash` and `deepseek-v4-pro`.
// DeepSeek's pricing page also documents the legacy aliases
// `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` as still accepted and
// forwarded to DeepSeek-V4.1-Flash, billed at the Flash price, so they share
// the same schedule. Every other name fails closed until it is verified: no
// `deepseek-*` wildcard is used, because future direct models may not share
// this schedule.
export const DEEPSEEK_API: PricingPolicy = {
  id: "deepseek-api",
  providers: ["deepseek"],
  models: [
    "deepseek-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
  ],
  timeZone: "UTC",
  blocked: DEEPSEEK_PEAK_WINDOWS,
  holidays: CHINA_PUBLIC_HOLIDAYS,
  multiplier: 2,
  source: "https://api-docs.deepseek.com/quick_start/pricing",
  verifiedAt: "2026-10-15",
};

/** Every built-in policy shipped by this release, in documentation order. */
export const BUILTIN_POLICIES: PricingPolicy[] = [DEEPSEEK_OPENCODE_GO, DEEPSEEK_API];

/**
 * Providers whose official pricing pages have been verified to contain no
 * peak/off-peak tiers at all: every model has one all-hours price. The plugin
 * deliberately installs no policy for them — there is no window to wait for —
 * so their requests are never delayed or blocked (`UNTRACKED`), and a new
 * model of such a provider can never be blocked just because a DeepSeek policy
 * exists elsewhere. This data is documentation for status output; it never
 * changes enforcement.
 */
export interface FlatProviderFact {
  name: string;
  note: string;
  source: string;
  verifiedAt: string;
}

export const VERIFIED_FLAT_PROVIDERS: Record<string, FlatProviderFact> = {
  opencode: {
    name: "OpenCode Zen",
    note: "Zen publishes one all-hours price per model with no peak/off-peak tiers, so there is no off-peak window to wait for and requests are never delayed.",
    source: "https://opencode.ai/docs/zen/",
    verifiedAt: "2026-10-15",
  },
};

export function flatProviderNote(providerID: string): string | undefined {
  return VERIFIED_FLAT_PROVIDERS[providerID.toLowerCase()]?.note;
}

const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MINUTE_MS = 60_000;
// A transition is normally less than a week away; the longest Chinese holiday
// run (the Spring Festival) can push the next weekly PEAK window just past a
// week, so the scan looks two weeks ahead before failing closed.
const MAX_LOOKAHEAD_DAYS = 14;
const MAX_LOOKAHEAD_MINUTES = MAX_LOOKAHEAD_DAYS * 24 * 60;

export function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new Error(`Invalid IANA time zone: ${timeZone}`);
  }
}

export function validatePolicy(policy: PricingPolicy): void {
  if (!policy.id.trim()) throw new Error("Pricing policy id is required.");
  if (!policy.providers.length || policy.providers.some((item) => !item.trim())) {
    throw new Error(`Policy ${policy.id} must match at least one provider.`);
  }
  if (!policy.models.length || policy.models.some((item) => !item.trim())) {
    throw new Error(`Policy ${policy.id} must match at least one model.`);
  }
  if (policy.flatModels !== undefined) {
    if (!Array.isArray(policy.flatModels) || policy.flatModels.some((item) => !item.trim())) {
      throw new Error(`Policy ${policy.id} flat model patterns must be non-empty strings.`);
    }
  }
  validateTimeZone(policy.timeZone);
  if (!policy.blocked.length) throw new Error(`Policy ${policy.id} must define blocked windows.`);
  for (const window of policy.blocked) {
    if (
      !window.days.length ||
      window.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    ) {
      throw new Error(`Policy ${policy.id} contains an invalid weekday.`);
    }
    const start = minuteOfDay(window.start);
    const end = minuteOfDay(window.end);
    if (start === end) throw new Error(`Policy ${policy.id} contains a zero-length window.`);
  }
  if (policy.holidays !== undefined) {
    if (!Array.isArray(policy.holidays)) {
      throw new Error(`Policy ${policy.id} holiday calendars must be an array.`);
    }
    for (const calendar of policy.holidays) validateHolidayCalendar(policy.id, calendar);
  }
  if (
    policy.multiplier !== undefined &&
    (!Number.isFinite(policy.multiplier) || policy.multiplier < 1)
  ) {
    throw new Error(`Policy ${policy.id} has an invalid price multiplier.`);
  }
}

function validateHolidayCalendar(policyID: string, calendar: HolidayCalendar): void {
  const label = `Policy ${policyID} holiday calendar`;
  if (!Number.isInteger(calendar.year)) throw new Error(`${label} year must be an integer.`);
  if (typeof calendar.timeZone !== "string" || !calendar.timeZone.trim()) {
    throw new Error(`${label} for ${calendar.year} requires an IANA time zone.`);
  }
  validateTimeZone(calendar.timeZone);
  if (typeof calendar.source !== "string" || !calendar.source.trim()) {
    throw new Error(`${label} for ${calendar.year} requires a source URL.`);
  }
  if (!Array.isArray(calendar.dates)) {
    throw new Error(`${label} for ${calendar.year} dates must be an array.`);
  }
  for (const date of calendar.dates) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) throw new Error(`${label} date ${date} must be formatted as YYYY-MM-DD.`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month - 1 ||
      probe.getUTCDate() !== day
    ) {
      throw new Error(`${label} date ${date} is not a real calendar date.`);
    }
    if (year !== calendar.year) {
      throw new Error(`${label} date ${date} does not belong to calendar year ${calendar.year}.`);
    }
  }
  if (new Set(calendar.dates).size !== calendar.dates.length) {
    throw new Error(`${label} for ${calendar.year} contains duplicate dates.`);
  }
}

function minuteOfDay(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid time ${value}; expected HH:mm.`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid time ${value}; expected HH:mm.`);
  return hour * 60 + minute;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  validateTimeZone(timeZone);
  return new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function localParts(epochMs: number, format: Intl.DateTimeFormat) {
  const parts = Object.fromEntries(
    format.formatToParts(epochMs).map(({ type, value }) => [type, value]),
  );
  const weekdayIndex = dayNames.findIndex((day) => day.startsWith(parts.weekday ?? ""));
  if (weekdayIndex < 0) throw new Error("Could not determine local weekday.");
  return {
    weekday: weekdayIndex as Weekday,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const holidayFormatters = new Map<string, Intl.DateTimeFormat>();

function holidayFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = holidayFormatters.get(timeZone);
  if (cached) return cached;
  validateTimeZone(timeZone);
  const format = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  holidayFormatters.set(timeZone, format);
  return format;
}

function calendarDate(epochMs: number, format: Intl.DateTimeFormat): string {
  const parts = Object.fromEntries(
    format.formatToParts(epochMs).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Full-day OFF_PEAK exceptions (for example Chinese statutory public
 * holidays) override every weekly PEAK window for the whole calendar day in
 * the calendar's own time zone, so the host-local time zone never matters.
 */
function isFullDayOffPeak(policy: PricingPolicy, epochMs: number): boolean {
  for (const calendar of policy.holidays ?? []) {
    if (calendar.dates.includes(calendarDate(epochMs, holidayFormatter(calendar.timeZone)))) {
      return true;
    }
  }
  return false;
}

function isBlockedAt(policy: PricingPolicy, epochMs: number, format: Intl.DateTimeFormat): boolean {
  if (isFullDayOffPeak(policy, epochMs)) return false;
  const local = localParts(epochMs, format);
  return policy.blocked.some((window) => {
    const start = minuteOfDay(window.start);
    const end = minuteOfDay(window.end);
    if (start < end)
      return window.days.includes(local.weekday) && local.minute >= start && local.minute < end;

    const previousDay = ((local.weekday + 6) % 7) as Weekday;
    return (
      (window.days.includes(local.weekday) && local.minute >= start) ||
      (window.days.includes(previousDay) && local.minute < end)
    );
  });
}

function nextTransition(policy: PricingPolicy, nowMs: number, currentBlocked: boolean): number {
  const format = formatter(policy.timeZone);
  const first = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let minute = 0; minute <= MAX_LOOKAHEAD_MINUTES; minute += 1) {
    const candidate = first + minute * MINUTE_MS;
    if (isBlockedAt(policy, candidate, format) !== currentBlocked) return candidate;
  }
  throw new Error(
    `No pricing transition found in the next ${MAX_LOOKAHEAD_DAYS} days for ${policy.id}.`,
  );
}

function matches(pattern: string, modelID: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(modelID);
}

export function resolvePolicy(
  policies: PricingPolicy[],
  providerID: string,
  modelID: string,
): PricingPolicy | undefined {
  const providerPolicies = policies.filter((policy) =>
    policy.providers.some((provider) => provider.toLowerCase() === providerID.toLowerCase()),
  );
  if (!providerPolicies.length) return undefined;
  const modelPolicies = providerPolicies.filter((policy) =>
    policy.models.some((model) => matches(model, modelID)),
  );
  if (modelPolicies.length > 1) {
    throw new Error(`More than one pricing policy matches ${providerID}/${modelID}.`);
  }
  if (!modelPolicies.length) {
    // A flat-priced model has no peak window at all, so it is never blocked;
    // `models` keeps precedence when a pattern matches both lists.
    const flatPolicies = providerPolicies.filter((policy) =>
      (policy.flatModels ?? []).some((model) => matches(model, modelID)),
    );
    if (flatPolicies.length > 1) {
      throw new Error(`More than one flat pricing policy matches ${providerID}/${modelID}.`);
    }
    if (flatPolicies.length) return flatPolicies[0];
    throw new Error(
      `Provider ${providerID} is configured, but model ${modelID} is not in the verified off-peak pricing policy for this release. Update opencode-offpeak or add a verified custom policy before using this model.`,
    );
  }
  return modelPolicies[0];
}

export function evaluatePricing(
  policies: PricingPolicy[],
  providerID: string,
  modelID: string,
  nowMs = Date.now(),
): PolicyDecision {
  let policy: PricingPolicy | undefined;
  try {
    policy = resolvePolicy(policies, providerID, modelID);
    if (!policy)
      return { state: "UNTRACKED", allowed: true, reason: "No policy matches this provider." };
    validatePolicy(policy);
    if (!policy.models.some((model) => matches(model, modelID))) {
      return {
        state: "FLAT",
        allowed: true,
        policy,
        reason: `${providerID}/${modelID} has flat all-hours pricing and no peak window.`,
      };
    }
    const format = formatter(policy.timeZone);
    const peak = isBlockedAt(policy, nowMs, format);
    return {
      state: peak ? "PEAK" : "OFF_PEAK",
      allowed: !peak,
      policy,
      nextTransition: nextTransition(policy, nowMs, peak),
    };
  } catch (error) {
    return {
      state: "UNKNOWN",
      allowed: false,
      ...(policy ? { policy } : {}),
      reason: error instanceof Error ? error.message : "Unknown pricing policy error.",
    };
  }
}

export function formatInTimeZone(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(epochMs);
}

/**
 * Compact hold deadline such as `17:00 Asia/Bangkok`, with a local date prefix
 * (`Oct 19, 01:00 Asia/Bangkok`) when the deadline falls on a different
 * calendar day in that time zone than `nowMs` does.
 */
export function formatTransitionInTimeZone(
  epochMs: number,
  timeZone: string,
  nowMs = Date.now(),
): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(epochMs);
  const day = (value: number) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  const label = `${time} ${timeZone}`;
  if (day(epochMs) === day(nowMs)) return label;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(epochMs);
  return `${date}, ${label}`;
}
