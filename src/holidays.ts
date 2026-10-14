/**
 * Full-day OFF_PEAK exception calendars for the built-in pricing policies.
 *
 * Chinese statutory public holidays are OFF_PEAK all day under the DeepSeek /
 * OpenCode Go pricing rules, even when they fall on a weekday inside a weekly
 * PEAK window. Official weekend make-up working days are not modelled: DeepSeek
 * defines weekends as off-peak, so an adjusted Saturday or Sunday stays
 * OFF_PEAK.
 *
 * The State Council publishes the next year's arrangement in the previous
 * November, so this file needs one data update per year. A year without a
 * calendar keeps the normal weekday/weekend schedule deterministically; it
 * never guesses future holidays.
 */

export interface HolidayCalendar {
  /** Calendar year the dates belong to, evaluated in `timeZone`. */
  year: number;
  /** IANA time zone whose calendar dates this list is defined in. */
  timeZone: string;
  /** Full-day OFF_PEAK dates, `YYYY-MM-DD` in `timeZone`. */
  dates: string[];
  /** Authoritative source URL for the calendar. */
  source: string;
  /** Date the list was verified against the source. */
  verifiedAt?: string;
  /** Human description of the list and its authority. */
  description?: string;
}

/**
 * Chinese statutory public holidays for 2026.
 *
 * Source: 国务院办公厅关于2026年部分节假日安排的通知 (国办发明电〔2025〕7号),
 * published 2025-11-04. Holiday periods: Jan 1-3, Feb 15-23, Apr 4-6,
 * May 1-5, Jun 19-21, Sep 25-27, Oct 1-7.
 *
 * Adjusted weekend workdays (Jan 4, Feb 14, Feb 28, May 9, Sep 20, Oct 10)
 * are intentionally not part of this list; they remain OFF_PEAK as weekends.
 */
export const CHINA_PUBLIC_HOLIDAYS_2026: HolidayCalendar = {
  year: 2026,
  timeZone: "Asia/Shanghai",
  dates: [
    "2026-01-01",
    "2026-01-02",
    "2026-01-03",
    "2026-02-15",
    "2026-02-16",
    "2026-02-17",
    "2026-02-18",
    "2026-02-19",
    "2026-02-20",
    "2026-02-21",
    "2026-02-22",
    "2026-02-23",
    "2026-04-04",
    "2026-04-05",
    "2026-04-06",
    "2026-05-01",
    "2026-05-02",
    "2026-05-03",
    "2026-05-04",
    "2026-05-05",
    "2026-06-19",
    "2026-06-20",
    "2026-06-21",
    "2026-09-25",
    "2026-09-26",
    "2026-09-27",
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
    "2026-10-04",
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
  ],
  source: "https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html",
  verifiedAt: "2026-10-14",
  description:
    "Chinese statutory public holidays; State Council notice 国办发明电〔2025〕7号 (2025-11-04)",
};

/** Holiday calendars available to the built-in policies, newest last. */
export const CHINA_PUBLIC_HOLIDAYS: HolidayCalendar[] = [CHINA_PUBLIC_HOLIDAYS_2026];
