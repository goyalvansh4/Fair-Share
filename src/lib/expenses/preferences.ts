export type SplitModePreference = 'equal' | 'shares' | 'exact';

export type ExpensePreferences = {
  payerId: string;
  participantIds: string[];
  category: string;
  splitMode: SplitModePreference;
};

export function preferencesKey(slug: string): string {
  return `fairshare.expense-preferences.${slug}`;
}

/** Parses stored JSON defensively: corrupted, foreign or outdated data yields null instead of throwing. */
export function parsePreferences(raw: string | null): ExpensePreferences | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const participantIds = Array.isArray(record.participantIds)
      ? record.participantIds.filter((id): id is string => typeof id === 'string')
      : [];
    const splitMode = record.splitMode === 'shares' || record.splitMode === 'exact' ? record.splitMode : 'equal';
    return {
      payerId: typeof record.payerId === 'string' ? record.payerId : '',
      participantIds,
      category: typeof record.category === 'string' ? record.category : 'food',
      splitMode,
    };
  } catch {
    return null;
  }
}

/**
 * Applies remembered choices to the members who are active right now. People who left are dropped,
 * and an empty result falls back to "everyone" so the form is never unusable.
 */
export function resolvePreferences(
  stored: ExpensePreferences | null,
  activeMemberIds: string[],
  currentUserId: string,
  validCategories: string[],
): ExpensePreferences {
  const active = new Set(activeMemberIds);
  const remembered = (stored?.participantIds ?? []).filter(id => active.has(id));
  const payerId = stored && active.has(stored.payerId)
    ? stored.payerId
    : active.has(currentUserId) ? currentUserId : activeMemberIds[0] ?? '';
  return {
    payerId,
    participantIds: remembered.length ? remembered : [...activeMemberIds],
    category: stored && validCategories.includes(stored.category) ? stored.category : 'food',
    splitMode: stored?.splitMode ?? 'equal',
  };
}
