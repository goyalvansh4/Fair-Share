export type SharingMember = { user_id: string; share_from?: string | null };

/**
 * Who shares a whole-group expense dated `expenseDate` (YYYY-MM-DD)?
 * Mirrors the database rule: a member with no share_from shares everything; otherwise only expenses
 * dated on or after their share_from date. Dates compare as plain strings, never as timezone-shifted instants.
 */
export function eligibleGroupMemberIds(members: SharingMember[], expenseDate: string): string[] {
  return members
    .filter(member => !member.share_from || member.share_from <= expenseDate)
    .map(member => member.user_id);
}
