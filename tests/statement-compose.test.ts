import { describe, expect, it } from 'vitest';
import { buildStatement } from '../src/lib/statements/build';
import { composeStatementEmail } from '../src/lib/statements/compose';
import { monthRange } from '../src/lib/statements/period';

function statementFor(name: string) {
  return buildStatement({
    organization: { name, currency: 'INR' },
    period: monthRange('2026-10'),
    members: [{ id: 'a', name: 'Asha', active: true }, { id: 'b', name: 'Bala <b>', active: true }],
    expenses: [{ id: '1', title: 'Hotel', category: 'accommodation', expense_date: '2026-10-05', payer_id: 'a', amount_minor: 30000, splits: [{ member_id: 'a', amount_minor: 15000 }, { member_id: 'b', amount_minor: 15000 }] }],
    settlements: [],
    generatedAt: new Date('2026-11-01T00:00:00Z'),
  });
}

describe('composeStatementEmail', () => {
  it('summarises spend, balances and who pays whom', () => {
    const email = composeStatementEmail(statementFor('Goa trip'));
    expect(email.subject).toBe('Goa trip: October 2026 statement');
    expect(email.text).toContain('INR 300.00 spent across 1 expense in October 2026.');
    expect(email.text).toContain('Asha gets back INR 150.00');
    expect(email.text).toContain('Bala <b> pays Asha INR 150.00'.replace('Bala <b> pays Asha', 'Bala <b> pays Asha'));
    expect(email.text).toContain('attached as a PDF');
  });
  it('escapes names in the HTML body', () => {
    const email = composeStatementEmail(statementFor('<script>alert(1)</script>'));
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(email.html).toContain('Bala &lt;b&gt;');
  });
  it('says so when everyone is settled', () => {
    const statement = buildStatement({
      organization: { name: 'Flat', currency: 'INR' }, period: monthRange('2026-10'),
      members: [{ id: 'a', name: 'Asha', active: true }], expenses: [], settlements: [], generatedAt: new Date('2026-11-01T00:00:00Z'),
    });
    expect(composeStatementEmail(statement).text).toContain('Everyone is settled up.');
  });
});
