import { describe, expect, it } from 'vitest';
import { type ExtractedEntry, markDuplicates, MAX_BULK_ENTRIES, toEntrySuggestions } from '../src/lib/receipts/suggestion';

const categories = ['food', 'groceries', 'miscellaneous'];
const entry = (overrides: Partial<ExtractedEntry> = {}): ExtractedEntry => ({
  title: 'Blinkit', description: 'Milk, bread', amount: 245.5, currency: 'INR', date: '2026-10-28',
  category: 'groceries', direction: 'paid', person_name: null, confidence: 'high', ...overrides,
});

describe('toEntrySuggestions', () => {
  it('converts every entry with the single-receipt safety rules', () => {
    const [first, second] = toEntrySuggestions([entry(), entry({ amount: -4, date: '2031-01-01', category: 'weird' })], 'INR', categories, '2026-10-30');
    expect(first).toMatchObject({ title: 'Blinkit', amount_minor: 24550, date: '2026-10-28', category: 'groceries', direction: 'paid' });
    expect(second).toMatchObject({ amount_minor: null, date: null, category: 'miscellaneous' });
  });
  it('keeps who and what the entry was about, trimmed', () => {
    const [result] = toEntrySuggestions([entry({ person_name: '  Ravi ', description: ' Dinner at Ravi ' })], 'INR', categories, '2026-10-30');
    expect(result.person_name).toBe('Ravi');
    expect(result.description).toBe('Dinner at Ravi');
  });
  it('flags foreign currency instead of converting it', () => {
    const [result] = toEntrySuggestions([entry({ currency: 'USD' })], 'INR', categories, '2026-10-30');
    expect(result.currency_mismatch).toBe('USD');
    expect(result.amount_minor).toBeNull();
  });
  it('caps the number of entries', () => {
    const many = Array.from({ length: MAX_BULK_ENTRIES + 25 }, () => entry());
    expect(toEntrySuggestions(many, 'INR', categories, '2026-10-30')).toHaveLength(MAX_BULK_ENTRIES);
  });
});

describe('markDuplicates', () => {
  const existing = [{ expense_date: '2026-10-28', amount_minor: 24550 }];
  it('flags an entry that matches a saved expense by date and amount', () => {
    expect(markDuplicates([{ title: 'Blinkit', amount_minor: 24550, date: '2026-10-28' }], existing)).toEqual(['existing']);
    expect(markDuplicates([{ title: 'Blinkit', amount_minor: 24550, date: '2026-10-29' }], existing)).toEqual([null]);
  });
  it('flags the same payment seen twice in one batch, but not two payments to different people', () => {
    const result = markDuplicates([
      { title: 'Ravi Kumar', amount_minor: 500, date: '2026-10-20' },
      { title: 'ravi  kumar', amount_minor: 500, date: '2026-10-20' },
      { title: 'Meena', amount_minor: 500, date: '2026-10-20' },
    ], []);
    expect(result).toEqual([null, 'repeat', null]);
  });
  it('never flags entries that lack an amount or a date', () => {
    expect(markDuplicates([{ title: 'x', amount_minor: null, date: '2026-10-28' }, { title: 'x', amount_minor: 5, date: null }], existing)).toEqual([null, null]);
  });
});
