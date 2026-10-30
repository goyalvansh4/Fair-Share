export type RecipientMode = 'all_members' | 'admins' | 'extra_only';

export type MemberContact = { role: string; email: string | null };

export const MAX_RECIPIENTS = 50;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Who gets the statement: the chosen group of members plus any extra addresses. Addresses are lowercased,
 * de-duplicated and validated, and at most MAX_RECIPIENTS are returned so one space cannot send a flood of mail.
 */
export function resolveRecipients(mode: RecipientMode, members: MemberContact[], extraEmails: string[]): string[] {
  const fromMembers = mode === 'extra_only'
    ? []
    : members.filter(member => mode === 'all_members' || member.role === 'admin').map(member => member.email ?? '');
  const unique = new Set<string>();
  for (const raw of [...fromMembers, ...extraEmails]) {
    const email = raw.trim().toLowerCase();
    if (email && email.length <= 254 && EMAIL.test(email)) unique.add(email);
  }
  return [...unique].slice(0, MAX_RECIPIENTS);
}
