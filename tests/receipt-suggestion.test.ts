import { describe, expect, it } from 'vitest';
import { type ExtractedReceipt, toSuggestion } from '../src/lib/receipts/suggestion';

const categories = ['food', 'rent', 'miscellaneous'];
const base: ExtractedReceipt = {
  is_receipt: true,
  title: 'Cafe Madras',
  total: 1234.5,
  currency: 'INR',
  date: '2026-10-28',
  category: 'food',
  confidence: 'high',
  notes: '',
};

describe('toSuggestion', () => {
  it('converts the total to minor units and keeps valid fields', () => {
    expect(toSuggestion(base, 'INR', categories, '2026-10-30')).toEqual({
      title: 'Cafe Madras', amount_minor: 123450, date: '2026-10-28', category: 'food',
      confidence: 'high', currency_mismatch: null, notes: '',
    });
  });
  it('rounds floating point noise correctly', () => {
    expect(toSuggestion({ ...base, total: 19.99 }, 'INR', categories, '2026-10-30').amount_minor).toBe(1999);
    expect(toSuggestion({ ...base, total: 0.1 + 0.2 }, 'INR', categories, '2026-10-30').amount_minor).toBe(30);
  });
  it('respects zero-decimal currencies', () => {
    expect(toSuggestion({ ...base, total: 1500, currency: 'JPY' }, 'JPY', categories, '2026-10-30').amount_minor).toBe(1500);
  });
  it('flags a different currency instead of converting it', () => {
    const result = toSuggestion({ ...base, currency: 'usd', total: 25 }, 'INR', categories, '2026-10-30');
    expect(result.currency_mismatch).toBe('USD');
    expect(result.amount_minor).toBeNull();
    expect(result.confidence).toBe('low');
  });
  it('drops unreadable, negative or absurd totals', () => {
    expect(toSuggestion({ ...base, total: null }, 'INR', categories, '2026-10-30').amount_minor).toBeNull();
    expect(toSuggestion({ ...base, total: -5 }, 'INR', categories, '2026-10-30').amount_minor).toBeNull();
    expect(toSuggestion({ ...base, total: Number.POSITIVE_INFINITY }, 'INR', categories, '2026-10-30').amount_minor).toBeNull();
    expect(toSuggestion({ ...base, total: 1e300 }, 'INR', categories, '2026-10-30').amount_minor).toBeNull();
  });
  it('rejects impossible and future dates', () => {
    expect(toSuggestion({ ...base, date: '2026-02-30' }, 'INR', categories, '2026-10-30').date).toBeNull();
    expect(toSuggestion({ ...base, date: '2027-01-01' }, 'INR', categories, '2026-10-30').date).toBeNull();
    expect(toSuggestion({ ...base, date: '28/10/2026' }, 'INR', categories, '2026-10-30').date).toBeNull();
    expect(toSuggestion({ ...base, date: null }, 'INR', categories, '2026-10-30').date).toBeNull();
  });
  it('falls back to "miscellaneous" for unknown categories', () => {
    expect(toSuggestion({ ...base, category: 'crypto' }, 'INR', categories, '2026-10-30').category).toBe('miscellaneous');
  });
  it('treats something that is not a receipt as low confidence with no amount', () => {
    const result = toSuggestion({ ...base, is_receipt: false }, 'INR', categories, '2026-10-30');
    expect(result.amount_minor).toBeNull();
    expect(result.confidence).toBe('low');
  });
  it('truncates long text', () => {
    const result = toSuggestion({ ...base, title: 'x'.repeat(500), notes: 'y'.repeat(900) }, 'INR', categories, '2026-10-30');
    expect(result.title).toHaveLength(140);
    expect(result.notes).toHaveLength(300);
  });
});
