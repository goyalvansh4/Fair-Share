import { splitEqually } from './engine';

export type FilterableExpense = {
  title: string;
  category: string;
  payer_id: string;
  amount_minor: number;
  expense_date: string;
  expense_splits: { member_id: string; amount_minor: number }[];
};

export type ExpenseFilter = {
  query: string;
  from: string;
  to: string;
  /** Text searched in addition to title/category, e.g. the payer's display name. */
  extraText?: (expense: FilterableExpense) => string;
};

/** Case-insensitive text search plus an inclusive YYYY-MM-DD date range. Empty bounds are open-ended. */
export function filterExpenses<T extends FilterableExpense>(expenses: T[], filter: ExpenseFilter): T[] {
  const query = filter.query.trim().toLowerCase();
  return expenses.filter(expense => {
    if (filter.from && expense.expense_date < filter.from) return false;
    if (filter.to && expense.expense_date > filter.to) return false;
    if (!query) return true;
    return `${expense.title} ${expense.category} ${filter.extraText?.(expense) ?? ''}`.toLowerCase().includes(query);
  });
}

export function sumExpenses(expenses: { amount_minor: number }[]): number {
  return expenses.reduce((sum, expense) => sum + expense.amount_minor, 0);
}

/** An edited expense opens as "equal" only when its saved splits are exactly the equal split; otherwise exact amounts. */
export function inferSplitMode(expense: Pick<FilterableExpense, 'amount_minor' | 'expense_splits'>): 'equal' | 'exact' {
  const ids = expense.expense_splits.map(split => split.member_id);
  if (!ids.length) return 'equal';
  try {
    const equal = new Map(splitEqually(expense.amount_minor, ids).map(split => [split.memberId, split.amountMinor]));
    return expense.expense_splits.every(split => equal.get(split.member_id) === split.amount_minor) ? 'equal' : 'exact';
  } catch {
    return 'exact';
  }
}

/** Local calendar date as YYYY-MM-DD (never UTC, so "today" is correct late at night in any timezone). */
export function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function startOfMonth(date: Date): string {
  return toDateInput(new Date(date.getFullYear(), date.getMonth(), 1));
}

export function daysAgo(date: Date, days: number): string {
  return toDateInput(new Date(date.getFullYear(), date.getMonth(), date.getDate() - days));
}
