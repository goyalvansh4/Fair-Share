import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildStatement } from '../src/lib/statements/build';
import { pdfMoney, renderStatementPdf, safeText } from '../src/lib/statements/pdf';
import { monthRange } from '../src/lib/statements/period';

describe('pdf text helpers', () => {
  it('replaces characters the standard fonts cannot encode', () => {
    expect(safeText('Chai ☕ and समोसा')).toBe('Chai ? and ?????');
    expect(safeText('Café\nbar')).toBe('Café bar');
  });
  it('formats money with the currency code', () => {
    expect(pdfMoney(123456, 'INR')).toBe('INR 1,234.56');
    expect(pdfMoney(-5000, 'INR')).toBe('-INR 50.00');
    expect(pdfMoney(1500, 'JPY')).toBe('JPY 1,500');
  });
});

describe('renderStatementPdf', () => {
  it('produces a valid multi-page PDF even with unusual names and many rows', async () => {
    const expenses = Array.from({ length: 80 }, (_, index) => ({
      id: String(index),
      title: index === 0 ? 'Chai ☕ with a really long description that must be truncated to fit inside its column nicely' : `Expense ${index}`,
      category: 'food',
      expense_date: '2026-10-10',
      payer_id: 'a',
      amount_minor: 1000,
      splits: [{ member_id: 'a', amount_minor: 500 }, { member_id: 'b', amount_minor: 500 }],
    }));
    const statement = buildStatement({
      organization: { name: 'गोवा ट्रिप', currency: 'INR' },
      period: monthRange('2026-10'),
      members: [{ id: 'a', name: 'आशा', active: true }, { id: 'b', name: 'Bala', active: true }],
      expenses,
      settlements: [{ from_member_id: 'b', to_member_id: 'a', amount_minor: 100, status: 'pending', date: '2026-10-12' }],
      generatedAt: new Date('2026-11-01T00:00:00Z'),
    });
    const bytes = await renderStatementPdf(statement);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(2000);
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBeGreaterThan(1);
  });

  it('renders an empty month', async () => {
    const statement = buildStatement({
      organization: { name: 'Flat', currency: 'INR' },
      period: monthRange('2026-10'),
      members: [{ id: 'a', name: 'Asha', active: true }],
      expenses: [],
      settlements: [],
      generatedAt: new Date('2026-11-01T00:00:00Z'),
    });
    const bytes = await renderStatementPdf(statement);
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
