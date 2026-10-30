import { getCurrencyFractionDigits } from '../money';

export type ExtractedReceipt = {
  is_receipt: boolean;
  title: string;
  total: number | null;
  currency: string | null;
  date: string | null;
  category: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
};

export type ReceiptSuggestion = {
  title: string;
  /** Total in minor units of the space's currency, or null when it could not be read reliably. */
  amount_minor: number | null;
  date: string | null;
  category: string;
  confidence: 'high' | 'medium' | 'low';
  /** Currency printed on the receipt when it differs from the space's currency (amount is then not converted). */
  currency_mismatch: string | null;
  notes: string;
};

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Turns the model's reading of a receipt into something safe to prefill into the expense form. Nothing the model
 * says is trusted blindly: amounts must be positive safe integers, dates must exist and not be in the future,
 * categories must be known, and foreign currencies are flagged instead of silently converted.
 */
export function toSuggestion(
  extracted: ExtractedReceipt,
  organizationCurrency: string,
  validCategories: string[],
  today: string,
): ReceiptSuggestion {
  const digits = getCurrencyFractionDigits(organizationCurrency);
  const printedCurrency = extracted.currency?.trim().toUpperCase() || null;
  const mismatch = printedCurrency && /^[A-Z]{3}$/.test(printedCurrency) && printedCurrency !== organizationCurrency.toUpperCase()
    ? printedCurrency
    : null;

  let amountMinor: number | null = null;
  if (extracted.is_receipt && !mismatch && typeof extracted.total === 'number' && Number.isFinite(extracted.total) && extracted.total > 0) {
    const minor = Math.round(extracted.total * 10 ** digits);
    if (Number.isSafeInteger(minor) && minor > 0) amountMinor = minor;
  }

  const date = extracted.date && isRealDate(extracted.date) && extracted.date <= today ? extracted.date : null;
  return {
    title: extracted.title.trim().slice(0, 140),
    amount_minor: amountMinor,
    date,
    category: validCategories.includes(extracted.category) ? extracted.category : 'miscellaneous',
    confidence: !extracted.is_receipt || amountMinor === null ? 'low' : extracted.confidence,
    currency_mismatch: mismatch,
    notes: extracted.notes.trim().slice(0, 300),
  };
}

/** One line of a photographed list, invoice or payment history, as read by the model. */
export type ExtractedEntry = {
  title: string;
  description: string;
  amount: number | null;
  currency: string | null;
  date: string | null;
  category: string;
  direction: 'paid' | 'received' | 'unknown';
  person_name: string | null;
  confidence: 'high' | 'medium' | 'low';
};

export type EntrySuggestion = {
  title: string;
  description: string;
  amount_minor: number | null;
  date: string | null;
  category: string;
  direction: 'paid' | 'received' | 'unknown';
  person_name: string | null;
  confidence: 'high' | 'medium' | 'low';
  currency_mismatch: string | null;
};

export const MAX_BULK_ENTRIES = 60;

/** Same safety rules as a single receipt, applied to every entry; at most MAX_BULK_ENTRIES are kept. */
export function toEntrySuggestions(
  entries: ExtractedEntry[],
  organizationCurrency: string,
  validCategories: string[],
  today: string,
): EntrySuggestion[] {
  return entries.slice(0, MAX_BULK_ENTRIES).map(entry => {
    const base = toSuggestion(
      { is_receipt: true, title: entry.title, total: entry.amount, currency: entry.currency, date: entry.date, category: entry.category, confidence: entry.confidence, notes: '' },
      organizationCurrency, validCategories, today,
    );
    return {
      title: base.title,
      description: entry.description.trim().slice(0, 300),
      amount_minor: base.amount_minor,
      date: base.date,
      category: base.category,
      direction: entry.direction,
      person_name: entry.person_name?.trim().slice(0, 100) || null,
      confidence: base.confidence,
      currency_mismatch: base.currency_mismatch,
    };
  });
}

export type DuplicateKind = 'existing' | 'repeat' | null;

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim();
}

/**
 * Flags entries that probably already exist, so scanning the same page twice (or two overlapping screenshots of one
 * payment history) does not add a payment twice. "existing": an expense with the same date and amount is already
 * saved. "repeat": an earlier entry in this batch has the same date, amount and title.
 */
export function markDuplicates(
  entries: { title: string; amount_minor: number | null; date: string | null }[],
  existing: { expense_date: string; amount_minor: number }[],
): DuplicateKind[] {
  const saved = new Set(existing.map(expense => `${expense.expense_date}|${expense.amount_minor}`));
  const seen = new Set<string>();
  return entries.map(entry => {
    if (entry.amount_minor === null || !entry.date) return null;
    if (saved.has(`${entry.date}|${entry.amount_minor}`)) return 'existing';
    const key = `${entry.date}|${entry.amount_minor}|${normalizeTitle(entry.title)}`;
    if (seen.has(key)) return 'repeat';
    seen.add(key);
    return null;
  });
}
