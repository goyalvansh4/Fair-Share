import { describe, expect, it } from 'vitest';
import { eligibleGroupMemberIds } from '../src/lib/expenses/group';

const members = [
  { user_id: 'founder', share_from: null },
  { user_id: 'joined-oct-20', share_from: '2026-10-20' },
  { user_id: 'legacy' },
];

describe('eligibleGroupMemberIds', () => {
  it('includes everyone for expenses on or after the latest start date', () => {
    expect(eligibleGroupMemberIds(members, '2026-10-20')).toEqual(['founder', 'joined-oct-20', 'legacy']);
    expect(eligibleGroupMemberIds(members, '2026-12-01')).toHaveLength(3);
  });
  it('excludes members whose start date is later than the expense', () => {
    expect(eligibleGroupMemberIds(members, '2026-10-19')).toEqual(['founder', 'legacy']);
  });
  it('treats a missing or null start date as "from the beginning"', () => {
    expect(eligibleGroupMemberIds(members, '1999-01-01')).toEqual(['founder', 'legacy']);
  });
  it('returns nobody when no member has started sharing yet', () => {
    expect(eligibleGroupMemberIds([{ user_id: 'a', share_from: '2026-11-01' }], '2026-10-01')).toEqual([]);
    expect(eligibleGroupMemberIds([], '2026-10-01')).toEqual([]);
  });
});
