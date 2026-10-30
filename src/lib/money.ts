export function getCurrencyFractionDigits(currency: string): number {
  const fractionDigits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  if (typeof fractionDigits !== 'number') throw new Error(`Unable to determine fraction digits for ${currency}`);
  return fractionDigits;
}

export function parseMinorUnits(value: string, currency: string): number {
  const fractionDigits = getCurrencyFractionDigits(currency);
  const decimalPart = fractionDigits === 0 ? '' : `(?:\\.\\d{1,${fractionDigits}})?`;
  if (!new RegExp(`^\\d+${decimalPart}$`).test(value.trim())) {
    throw new Error(`Enter an amount with up to ${fractionDigits} decimal places`);
  }

  const [whole, fraction = ''] = value.trim().split('.');
  const factor = BigInt(10) ** BigInt(fractionDigits);
  const minor = BigInt(whole) * factor + BigInt(fraction.padEnd(fractionDigits, '0') || '0');
  if (minor <= BigInt(0) || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Amount must be positive and within the supported limit');
  }
  return Number(minor);
}

export function formatMinorUnits(amountMinor: number, currency: string, locale = 'en-IN'): string {
  if (!Number.isSafeInteger(amountMinor)) throw new Error('Amount must be a safe integer in minor currency units');
  const fractionDigits = getCurrencyFractionDigits(currency);
  const factor = 10 ** fractionDigits;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amountMinor / factor);
}
