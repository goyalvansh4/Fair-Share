export const ADMIN_ELEVATION_MINUTES = 30;
const MIN_PASSWORD_LENGTH = 12;

/** The console stays closed unless an operator configured a strong password secret. */
export function consolePasswordConfigured(): boolean {
  return (process.env.ADMIN_CONSOLE_PASSWORD ?? '').length >= MIN_PASSWORD_LENGTH;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Constant-time comparison of SHA-256 digests, so neither length nor content leaks through timing. */
export async function verifyConsolePassword(attempt: string): Promise<boolean> {
  const expected = process.env.ADMIN_CONSOLE_PASSWORD ?? '';
  if (expected.length < MIN_PASSWORD_LENGTH) return false;
  const [a, b] = await Promise.all([digest(attempt), digest(expected)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}
