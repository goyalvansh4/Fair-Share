import { describe, expect, it } from 'vitest';
import { dueStatementPeriod, isMonthKey, localMonthAndDay, monthRange, previousMonthKey, recentMonthKeys } from '../src/lib/statements/period';

describe('monthRange', () => {
  it('returns first/last day and a label, including leap years', () => {
    expect(monthRange('2026-10')).toEqual({ key: '2026-10', from: '2026-10-01', to: '2026-10-31', label: 'October 2026' });
    expect(monthRange('2024-02').to).toBe('2024-02-29');
    expect(monthRange('2026-02').to).toBe('2026-02-28');
    expect(monthRange('2026-04').to).toBe('2026-04-30');
  });
  it('rejects malformed months', () => {
    expect(() => monthRange('2026-13')).toThrow();
    expect(() => monthRange('26-10')).toThrow();
    expect(isMonthKey('2026-00')).toBe(false);
    expect(isMonthKey('2026-12')).toBe(true);
  });
});

describe('previousMonthKey', () => {
  it('rolls back across a year boundary', () => {
    expect(previousMonthKey('2026-01')).toBe('2025-12');
    expect(previousMonthKey('2026-10')).toBe('2026-09');
  });
});

describe('localMonthAndDay', () => {
  it('uses the organization timezone, not UTC', () => {
    const lateUtc = new Date('2026-10-31T20:00:00Z'); // already 1 November in Kolkata
    expect(localMonthAndDay(lateUtc, 'Asia/Kolkata')).toEqual({ key: '2026-11', day: 1 });
    expect(localMonthAndDay(lateUtc, 'UTC')).toEqual({ key: '2026-10', day: 31 });
  });
  it('falls back to UTC for an unknown timezone', () => {
    expect(localMonthAndDay(new Date('2026-10-05T12:00:00Z'), 'Not/AZone')).toEqual({ key: '2026-10', day: 5 });
  });
});

describe('dueStatementPeriod', () => {
  const base = { enabled: true, dayOfMonth: 5, lastSentPeriod: null as string | null };
  it('is not due before the chosen day', () => {
    expect(dueStatementPeriod(base, new Date('2026-11-04T12:00:00Z'), 'UTC')).toBeNull();
  });
  it('is due on and after the chosen day, for the previous month', () => {
    expect(dueStatementPeriod(base, new Date('2026-11-05T12:00:00Z'), 'UTC')).toBe('2026-10');
    expect(dueStatementPeriod(base, new Date('2026-11-20T12:00:00Z'), 'UTC')).toBe('2026-10');
  });
  it('sends only once per period', () => {
    expect(dueStatementPeriod({ ...base, lastSentPeriod: '2026-10' }, new Date('2026-11-20T12:00:00Z'), 'UTC')).toBeNull();
  });
  it('never sends when disabled', () => {
    expect(dueStatementPeriod({ ...base, enabled: false }, new Date('2026-11-20T12:00:00Z'), 'UTC')).toBeNull();
  });
  it('rolls into the next period the following month', () => {
    expect(dueStatementPeriod({ ...base, lastSentPeriod: '2026-10' }, new Date('2026-12-06T12:00:00Z'), 'UTC')).toBe('2026-11');
  });
  it('handles January (previous month is December of last year)', () => {
    expect(dueStatementPeriod({ ...base, dayOfMonth: 1 }, new Date('2027-01-01T12:00:00Z'), 'UTC')).toBe('2026-12');
  });
});

describe('recentMonthKeys', () => {
  it('lists complete months newest first, across a year boundary', () => {
    expect(recentMonthKeys(new Date('2026-02-10T12:00:00Z'), 'UTC', 3)).toEqual(['2026-01', '2025-12', '2025-11']);
  });
  it('uses the space timezone for "now"', () => {
    expect(recentMonthKeys(new Date('2026-10-31T20:00:00Z'), 'Asia/Kolkata', 1)).toEqual(['2026-10']);
    expect(recentMonthKeys(new Date('2026-10-31T20:00:00Z'), 'UTC', 1)).toEqual(['2026-09']);
  });
});
