export type SpaceActivity = {
  member_count: number;
  expense_count: number;
  last_activity_at: string;
  status: string;
};

export const INACTIVE_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since the last activity (never negative; an unreadable date counts as "just now"). */
export function daysSinceActivity(lastActivityAt: string, now: Date): number {
  const last = new Date(lastActivityAt).getTime();
  if (Number.isNaN(last)) return 0;
  return Math.max(0, Math.floor((now.getTime() - last) / DAY_MS));
}

/** No expenses were ever recorded and at most one person is in the space: the typical "just trying it out" space. */
export function isEmptySpace(space: Pick<SpaceActivity, 'member_count' | 'expense_count'>): boolean {
  return space.expense_count === 0 && space.member_count <= 1;
}

export function isInactiveSpace(space: SpaceActivity, now: Date, afterDays = INACTIVE_AFTER_DAYS): boolean {
  return daysSinceActivity(space.last_activity_at, now) >= afterDays;
}

export type SpaceFilter = 'all' | 'inactive' | 'empty' | 'paused';

export function matchesSpaceFilter(space: SpaceActivity, filter: SpaceFilter, now: Date): boolean {
  if (filter === 'inactive') return isInactiveSpace(space, now);
  if (filter === 'empty') return isEmptySpace(space);
  if (filter === 'paused') return space.status !== 'active';
  return true;
}

export function describeActivity(lastActivityAt: string, now: Date): string {
  const days = daysSinceActivity(lastActivityAt, now);
  if (days === 0) return 'Active today';
  if (days === 1) return 'Active yesterday';
  if (days < 30) return `Active ${days} days ago`;
  if (days < 365) return `Quiet for ${Math.floor(days / 30)} ${Math.floor(days / 30) === 1 ? 'month' : 'months'}`;
  return `Quiet for ${Math.floor(days / 365)} ${Math.floor(days / 365) === 1 ? 'year' : 'years'}`;
}
