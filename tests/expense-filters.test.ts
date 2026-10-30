import { describe, expect, it } from 'vitest';
import { daysAgo, filterExpenses, inferSplitMode, startOfMonth, sumExpenses, toDateInput } from '../src/lib/expenses/filters';

const base = { category: 'food', payer_id: 'a', expense_splits: [] };
const expenses = [
  { ...base, title: 'Dinner', amount_minor: 1000, expense_date: '2026-10-01' },
  { ...base, title: 'Cab', amount_minor: 500, expense_date: '2026-10-15' },
  { ...base, title: 'Hotel', amount_minor: 2500, expense_date: '2026-10-31' },
];

describe('filterExpenses', () => {
  it('treats both date bounds as inclusive', () => {
    const result = filterExpenses(expenses, { query: '', from: '2026-10-01', to: '2026-10-15' });
    expect(result.map(expense => expense.title)).toEqual(['Dinner', 'Cab']);
  });
  it('supports open-ended ranges', () => {
    expect(filterExpenses(expenses, { query: '', from: '2026-10-16', to: '' })).toHaveLength(1);
    expect(filterExpenses(expenses, { query: '', from: '', to: '2026-10-14' })).toHaveLength(1);
    expect(filterExpenses(expenses, { query: '', from: '', to: '' })).toHaveLength(3);
  });
  it('returns nothing for an inverted range', () => {
    expect(filterExpenses(expenses, { query: '', from: '2026-10-20', to: '2026-10-10' })).toEqual([]);
  });
  it('combines text search (including extra text) with dates', () => {
    const result = filterExpenses(expenses, { query: ' ASHA ', from: '2026-10-10', to: '', extraText: expense => expense.title === 'Hotel' ? 'Asha' : '' });
    expect(result.map(expense => expense.title)).toEqual(['Hotel']);
  });
  it('sums amounts in minor units', () => {
    expect(sumExpenses(expenses)).toBe(4000);
    expect(sumExpenses([])).toBe(0);
  });
});

describe('inferSplitMode', () => {
  it('detects an exactly equal split, including remainders', () => {
    expect(inferSplitMode({ amount_minor: 100, expense_splits: [{ member_id: 'a', amount_minor: 34 }, { member_id: 'b', amount_minor: 33 }, { member_id: 'c', amount_minor: 33 }] })).toBe('equal');
  });
  it('falls back to exact amounts for uneven splits', () => {
    expect(inferSplitMode({ amount_minor: 100, expense_splits: [{ member_id: 'a', amount_minor: 70 }, { member_id: 'b', amount_minor: 30 }] })).toBe('exact');
  });
  it('handles an expense without splits', () => {
    expect(inferSplitMode({ amount_minor: 100, expense_splits: [] })).toBe('equal');
  });
});

describe('date helpers', () => {
  it('formats local calendar dates and month boundaries', () => {
    expect(toDateInput(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(startOfMonth(new Date(2026, 9, 29))).toBe('2026-10-01');
    expect(daysAgo(new Date(2026, 2, 1), 1)).toBe('2026-02-28');
    expect(daysAgo(new Date(2026, 0, 1), 30)).toBe('2025-12-02');
  });
});
