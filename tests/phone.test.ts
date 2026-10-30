import { describe, expect, it } from 'vitest';
import { formatPhone, normalizePhone } from '../src/lib/profile/phone';

describe('normalizePhone', () => {
  it('treats an empty value as "no number"', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
  });
  it('assumes India for a bare 10-digit mobile number', () => {
    expect(normalizePhone('98765 43210')).toBe('+919876543210');
    expect(normalizePhone('098765-43210')).toBe('+919876543210');
  });
  it('accepts international formats', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('+919876543210');
    expect(normalizePhone('+1 (415) 555-2671')).toBe('+14155552671');
    expect(normalizePhone('0044 20 7946 0958')).toBe('+442079460958');
  });
  it('rejects numbers that cannot be valid', () => {
    expect(() => normalizePhone('12345')).toThrow();
    expect(() => normalizePhone('5876543210')).toThrow(); // 10 digits but not a mobile prefix and no country code
    expect(() => normalizePhone('+0123456789')).toThrow();
    expect(() => normalizePhone('call me')).toThrow();
    expect(() => normalizePhone('+91 98765 432109999999')).toThrow();
  });
});

describe('formatPhone', () => {
  it('groups Indian and other numbers', () => {
    expect(formatPhone('+919876543210')).toBe('+91 98765 43210');
    expect(formatPhone('+14155552671')).toBe('+14155552671');
    expect(formatPhone(null)).toBe('');
  });
});
