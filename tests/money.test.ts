import { describe, expect, it } from 'vitest';
import { formatMinorUnits, getCurrencyFractionDigits, parseMinorUnits } from '../src/lib/money';

describe('currency minor-unit helpers', () => {
  it('parses INR decimal strings without floating-point arithmetic', () => {
    expect(parseMinorUnits('1250.45', 'INR')).toBe(125045);
    expect(parseMinorUnits('8', 'INR')).toBe(800);
  });

  it('respects currencies with zero or three fraction digits', () => {
    expect(getCurrencyFractionDigits('JPY')).toBe(0);
    expect(parseMinorUnits('1250', 'JPY')).toBe(1250);
    expect(getCurrencyFractionDigits('KWD')).toBe(3);
    expect(parseMinorUnits('1.234', 'KWD')).toBe(1234);
  });

  it('rejects invalid precision, zero, negative and unsafe amounts', () => {
    expect(() => parseMinorUnits('1.001', 'INR')).toThrow(/decimal places/);
    expect(() => parseMinorUnits('-1', 'INR')).toThrow(/decimal places/);
    expect(() => parseMinorUnits('0', 'INR')).toThrow(/positive/);
    expect(() => parseMinorUnits('90071992547409.92', 'INR')).toThrow(/supported limit/);
  });

  it('formats integer minor units with the organization currency', () => {
    expect(formatMinorUnits(125045, 'INR')).toContain('1,250.45');
    expect(formatMinorUnits(1250, 'JPY')).toContain('1,250');
    expect(() => formatMinorUnits(Number.NaN, 'INR')).toThrow(/safe integer/);
  });
});
