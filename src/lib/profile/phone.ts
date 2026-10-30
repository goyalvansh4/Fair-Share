/**
 * Normalizes a typed mobile number to E.164 ("+919876543210").
 * Returns null for an empty value, and throws a friendly Error for something that cannot be a phone number.
 * A bare 10-digit number starting 6-9 is treated as an Indian mobile number.
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/[^\d\s()+\-.]/.test(trimmed)) throw new Error('Phone numbers can contain only digits, spaces and +.');

  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    // international format: +<country code><number>
  } else if (trimmed.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.length === 10 && /^[6-9]/.test(digits)) {
    digits = `91${digits}`;
  } else if (digits.length === 11 && digits.startsWith('0') && /^[6-9]/.test(digits.slice(1))) {
    digits = `91${digits.slice(1)}`;
  } else {
    throw new Error('Enter the number with a country code, for example +91 98765 43210.');
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) throw new Error('That does not look like a valid phone number.');
  return `+${digits}`;
}

/** "+919876543210" -> "+91 98765 43210". Other countries keep the plain international form. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const india = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return india ? `+91 ${india[1]} ${india[2]}` : e164;
}
