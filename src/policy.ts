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
  models: string[];
  timeZone: string;
  blocked: WeeklyWindow[];
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
  state: "OFF_PEAK" | "PEAK" | "UNTRACKED" | "UNKNOWN";
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
// page documents the same windows for this provider
// (https://opencode.ai/docs/go/). Holiday dates come from the State Council
// calendar in src/holidays.ts.
export const DEEPSEEK_OPENCODE_GO: PricingPolicy = {
  id: "deepseek-opencode-go",
  providers: ["opencode-go"],
  models: [
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
  ],
  timeZone: "UTC",
  blocked: [
    { days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" },
    { days: [1, 2, 3, 4, 5], start: "06:00", end: "10:00" },
  ],
  holidays: CHINA_PUBLIC_HOLIDAYS,
  multiplier: 2,
  source: "https://opencode.ai/docs/go/",
  verifiedAt: "2026-10-14",
};

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
    throw new Error(
      `Provider ${providerID} is configured, but model ${modelID} has no pricing policy.`,
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
