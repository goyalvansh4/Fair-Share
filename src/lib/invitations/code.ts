/** Invite codes are 12 hex characters shown as A1B2-C3D4-E5F6. Anything typed is cleaned up before use. */
export function normalizeInviteCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function isValidInviteCode(input: string): boolean {
  return /^[0-9A-F]{12}$/.test(normalizeInviteCode(input));
}

/** "a1b2c3d4e5f6" -> "A1B2-C3D4-E5F6"; partial input is grouped as it is typed. */
export function formatInviteCode(input: string): string {
  return (normalizeInviteCode(input).slice(0, 12).match(/.{1,4}/g) ?? []).join('-');
}

/** The secret code is the second factor: 8 to 32 letters or digits (generated ones are 10 hex characters, shown 9F3A1-C07BD). */
export function isValidSecretCode(input: string): boolean {
  return /^[0-9A-Z]{8,32}$/.test(normalizeInviteCode(input));
}

/** Generated 10-character secrets are grouped 5-5 for reading aloud; custom secrets are shown as typed (uppercase). */
export function formatSecretCode(input: string): string {
  const normalized = normalizeInviteCode(input).slice(0, 32);
  return normalized.length === 10 ? `${normalized.slice(0, 5)}-${normalized.slice(5)}` : normalized;
}
