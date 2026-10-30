/** Calendar-month helpers for statements. Month keys look like "2026-10". Dates are plain YYYY-MM-DD strings. */

export type MonthRange = { key: string; from: string; to: string; label: string };

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: string): boolean {
  return MONTH_KEY.test(value);
}

export function monthRange(key: string): MonthRange {
  const match = MONTH_KEY.exec(key);
  if (!match) throw new Error('Month must look like 2026-10');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const label = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, 1)));
  return {
    key,
    from: `${match[1]}-${match[2]}-01`,
    to: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`,
    label,
  };
}

export function previousMonthKey(key: string): string {
  const match = MONTH_KEY.exec(key);
  if (!match) throw new Error('Month must look like 2026-10');
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/** Today's calendar date in an IANA timezone, as { key: "2026-10", day: 30 }. */
export function localMonthAndDay(now: Date, timeZone: string): { key: string; day: number } {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now);
  const pick = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return { key: `${pick('year')}-${pick('month')}`, day: Number(pick('day')) };
}

export type DueInput = { enabled: boolean; dayOfMonth: number; lastSentPeriod: string | null };

/**
 * The scheduled job runs daily. A statement for the previous month is due once the configured day of the
 * current month has arrived (so a missed day is caught up), and only once per period.
 */
export function dueStatementPeriod(settings: DueInput, now: Date, timeZone: string): string | null {
  if (!settings.enabled) return null;
  const today = localMonthAndDay(now, timeZone);
  const period = previousMonthKey(today.key);
  if (settings.lastSentPeriod === period) return null;
  if (settings.lastSentPeriod && settings.lastSentPeriod > period) return null;
  return today.day >= settings.dayOfMonth ? period : null;
}

/** The most recent complete months, newest first (the current, unfinished month is not included). */
export function recentMonthKeys(now: Date, timeZone: string, count: number): string[] {
  const keys: string[] = [];
  let key = previousMonthKey(localMonthAndDay(now, timeZone).key);
  for (let index = 0; index < count; index += 1) {
    keys.push(key);
    key = previousMonthKey(key);
  }
  return keys;
}
