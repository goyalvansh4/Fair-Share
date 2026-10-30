import { describe, expect, it } from 'vitest';
import { daysSinceActivity, describeActivity, isEmptySpace, isInactiveSpace, matchesSpaceFilter } from '../src/lib/admin/space-health';

const now = new Date('2026-10-30T12:00:00Z');
const space = (overrides = {}) => ({ member_count: 3, expense_count: 12, last_activity_at: '2026-10-29T10:00:00Z', status: 'active', ...overrides });

describe('space health', () => {
  it('counts whole days since the last activity', () => {
    expect(daysSinceActivity('2026-10-30T01:00:00Z', now)).toBe(0);
    expect(daysSinceActivity('2026-10-28T12:00:00Z', now)).toBe(2);
    expect(daysSinceActivity('2027-01-01T00:00:00Z', now)).toBe(0); // future dates never go negative
    expect(daysSinceActivity('not a date', now)).toBe(0);
  });
  it('flags spaces quiet for 30 days or more', () => {
    expect(isInactiveSpace(space({ last_activity_at: '2026-09-30T12:00:00Z' }), now)).toBe(true);
    expect(isInactiveSpace(space({ last_activity_at: '2026-10-01T12:00:00Z' }), now)).toBe(false);
  });
  it('flags empty try-out spaces', () => {
    expect(isEmptySpace({ member_count: 1, expense_count: 0 })).toBe(true);
    expect(isEmptySpace({ member_count: 2, expense_count: 0 })).toBe(false);
    expect(isEmptySpace({ member_count: 1, expense_count: 1 })).toBe(false);
  });
  it('filters', () => {
    expect(matchesSpaceFilter(space({ status: 'archived' }), 'paused', now)).toBe(true);
    expect(matchesSpaceFilter(space(), 'paused', now)).toBe(false);
    expect(matchesSpaceFilter(space(), 'all', now)).toBe(true);
    expect(matchesSpaceFilter(space({ expense_count: 0, member_count: 1 }), 'empty', now)).toBe(true);
  });
  it('describes activity in plain words', () => {
    expect(describeActivity('2026-10-30T08:00:00Z', now)).toBe('Active today');
    expect(describeActivity('2026-10-29T08:00:00Z', now)).toBe('Active yesterday');
    expect(describeActivity('2026-10-20T08:00:00Z', now)).toBe('Active 10 days ago');
    expect(describeActivity('2026-07-20T08:00:00Z', now)).toBe('Quiet for 3 months');
    expect(describeActivity('2025-09-01T08:00:00Z', now)).toBe('Quiet for 1 year');
  });
});
