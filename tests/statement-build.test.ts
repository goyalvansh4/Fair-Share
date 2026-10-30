import { describe, expect, it } from 'vitest';
import { buildStatement, type StatementInput } from '../src/lib/statements/build';
import { monthRange } from '../src/lib/statements/period';

const members = [
  { id: 'a', name: 'Asha', active: true },
  { id: 'b', name: 'Bala', active: true },
  { id: 'c', name: 'Chitra', active: false },
];

function input(overrides: Partial<StatementInput> = {}): StatementInput {
  return {
    organization: { name: 'Goa trip', currency: 'INR' },
    period: monthRange('2026-10'),
    members,
    expenses: [
      { id: '1', title: 'Old dinner', category: 'food', expense_date: '2026-09-28', payer_id: 'a', amount_minor: 10000, splits: [{ member_id: 'a', amount_minor: 5000 }, { member_id: 'b', amount_minor: 5000 }] },
      { id: '2', title: 'Hotel', category: 'accommodation', expense_date: '2026-10-05', payer_id: 'b', amount_minor: 30000, splits: [{ member_id: 'a', amount_minor: 15000 }, { member_id: 'b', amount_minor: 15000 }] },
      { id: '3', title: 'November cab', category: 'transport', expense_date: '2026-11-02', payer_id: 'a', amount_minor: 2000, splits: [{ member_id: 'a', amount_minor: 1000 }, { member_id: 'b', amount_minor: 1000 }] },
    ],
    settlements: [],
    generatedAt: new Date('2026-11-05T00:00:00Z'),
    ...overrides,
  };
}

describe('buildStatement', () => {
  it('totals only the chosen month but balances include earlier months', () => {
    const statement = buildStatement(input());
    expect(statement.expenseCount).toBe(1);
    expect(statement.totalSpendMinor).toBe(30000);
    const asha = statement.memberLines.find(line => line.memberId === 'a')!;
    const bala = statement.memberLines.find(line => line.memberId === 'b')!;
    expect(asha.paidMinor).toBe(0);
    expect(asha.shareMinor).toBe(15000);
    expect(asha.periodNetMinor).toBe(-15000);
    // Asha paid 10000 in September (share 5000) and owes 15000 for the hotel: -10000 overall. November is excluded.
    expect(asha.closingNetMinor).toBe(-10000);
    expect(bala.closingNetMinor).toBe(10000);
    expect(statement.warning).toBeNull();
  });

  it('suggests the payments that settle the closing balances', () => {
    const statement = buildStatement(input());
    expect(statement.transfers).toEqual([{ fromMemberId: 'a', toMemberId: 'b', amountMinor: 10000, fromName: 'Asha', toName: 'Bala' }]);
  });

  it('applies payments recorded up to period end and lists the ones in the month', () => {
    const statement = buildStatement(input({
      settlements: [
        { from_member_id: 'a', to_member_id: 'b', amount_minor: 10000, status: 'confirmed', date: '2026-10-20' },
        { from_member_id: 'a', to_member_id: 'b', amount_minor: 999, status: 'confirmed', date: '2026-11-03' },
      ],
    }));
    expect(statement.memberLines.every(line => line.closingNetMinor === 0)).toBe(true);
    expect(statement.transfers).toEqual([]);
    expect(statement.payments).toHaveLength(1);
    expect(statement.payments[0].fromName).toBe('Asha');
  });

  it('hides former members with nothing to show but keeps those with a balance', () => {
    expect(buildStatement(input()).memberLines.map(line => line.memberId)).toEqual(['b', 'a']);
    const withFormer = buildStatement(input({
      expenses: [
        { id: '9', title: 'Shared', category: 'food', expense_date: '2026-10-10', payer_id: 'c', amount_minor: 1000, splits: [{ member_id: 'a', amount_minor: 500 }, { member_id: 'c', amount_minor: 500 }] },
      ],
    }));
    expect(withFormer.memberLines.map(line => line.name)).toContain('Chitra');
  });

  it('reports a warning instead of wrong balances when the ledger does not reconcile', () => {
    const broken = buildStatement(input({
      expenses: [{ id: 'x', title: 'Broken', category: 'food', expense_date: '2026-10-05', payer_id: 'a', amount_minor: 100, splits: [{ member_id: 'a', amount_minor: 40 }] }],
    }));
    expect(broken.warning).toMatch(/does not match/i);
    expect(broken.transfers).toEqual([]);
    expect(broken.totalSpendMinor).toBe(100);
  });

  it('handles an empty month', () => {
    const statement = buildStatement(input({ expenses: [], settlements: [] }));
    expect(statement.expenseCount).toBe(0);
    expect(statement.totalSpendMinor).toBe(0);
    expect(statement.transfers).toEqual([]);
  });

  it('labels unknown people as former members', () => {
    const statement = buildStatement(input({ members: members.slice(0, 2), expenses: [
      { id: '5', title: 'Ghost', category: 'food', expense_date: '2026-10-10', payer_id: 'a', amount_minor: 100, splits: [{ member_id: 'a', amount_minor: 100 }] },
    ] }));
    expect(statement.expenses[0].payerName).toBe('Asha');
  });
});
