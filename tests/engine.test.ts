import { describe, expect, it } from 'vitest';
import { applySettlementAdjustments, calculateBalances, splitEqually, splitByWeights, suggestSettlements } from '../src/lib/expenses/engine';

describe('expense calculation engine', () => {
  it('splits equally in integer minor units and assigns remainder deterministically', () => {
    expect(splitEqually(1000, ['c', 'a', 'b'])).toEqual([
      { memberId: 'a', amountMinor: 334 }, { memberId: 'b', amountMinor: 333 }, { memberId: 'c', amountMinor: 333 },
    ]);
  });
  it('rejects no participants and duplicate participants', () => {
    expect(() => splitEqually(100, [])).toThrow();
    expect(() => splitEqually(100, ['a', 'a'])).toThrow();
  });
  it('allocates weighted splits without losing minor units', () => {
    const splits = splitByWeights(1001, [{ memberId: 'a', weight: 2 }, { memberId: 'b', weight: 1 }]);
    expect(splits.reduce((s, x) => s + x.amountMinor, 0)).toBe(1001);
    expect(splits).toEqual([{ memberId: 'a', amountMinor: 667 }, { memberId: 'b', amountMinor: 334 }]);
  });
  it('calculates paid, share and net balances and suggests settlements', () => {
    const members = ['vansh', 'aryan', 'sourav', 'manjeet'];
    const expenses = [
      { payerId: 'vansh', totalMinor: 1200000, splits: splitEqually(1200000, members) },
    ];
    const balances = calculateBalances(members, expenses);
    expect(balances.reduce((s, b) => s + b.netMinor, 0)).toBe(0);
    expect(balances.find(b => b.memberId === 'vansh')?.netMinor).toBe(900000);
    const transfers = suggestSettlements(balances);
    expect(transfers.reduce((s, t) => s + t.amountMinor, 0)).toBe(900000);
  });
  it('rejects a ledger whose splits do not reconcile', () => {
    expect(() => calculateBalances(['a', 'b'], [{ payerId: 'a', totalMinor: 200, splits: [{ memberId: 'a', amountMinor: 100 }] }])).toThrow(/does not match allocated splits/);
  });
  it('rejects unknown payers and negative splits', () => {
    expect(() => calculateBalances(['a'], [{ payerId: 'b', totalMinor: 0, splits: [] }])).toThrow(/Unknown payer/);
    expect(() => calculateBalances(['a'], [{ payerId: 'a', totalMinor: 0, splits: [{ memberId: 'a', amountMinor: -1 }] }])).toThrow(/Invalid split/);
  });
  it('adjusts balances for pending and confirmed transfers, but ignores cancelled transfers', () => {
    const balances = calculateBalances(['a', 'b'], [
      { payerId: 'a', totalMinor: 1000, splits: [{ memberId: 'b', amountMinor: 1000 }] },
    ]);
    expect(applySettlementAdjustments(balances, [
      { fromMemberId: 'b', toMemberId: 'a', amountMinor: 250, status: 'pending' },
    ]).map(balance => balance.netMinor)).toEqual([750, -750]);
    expect(applySettlementAdjustments(balances, [
      { fromMemberId: 'b', toMemberId: 'a', amountMinor: 1000, status: 'confirmed' },
    ]).map(balance => balance.netMinor)).toEqual([0, 0]);
    expect(applySettlementAdjustments(balances, [
      { fromMemberId: 'b', toMemberId: 'a', amountMinor: 250, status: 'cancelled' },
    ])).toEqual(balances);
  });
  it('rejects invalid settlement participants and unsafe accumulated balances', () => {
    const balances = calculateBalances(['a', 'b'], [
      { payerId: 'a', totalMinor: 1000, splits: [{ memberId: 'b', amountMinor: 1000 }] },
    ]);
    expect(() => applySettlementAdjustments(balances, [
      { fromMemberId: 'a', toMemberId: 'unknown', amountMinor: 100, status: 'pending' },
    ])).toThrow(/Invalid settlement adjustment/);
    expect(() => applySettlementAdjustments(balances, [
      { fromMemberId: 'b', toMemberId: 'a', amountMinor: Number.MAX_SAFE_INTEGER, status: 'pending' },
      { fromMemberId: 'b', toMemberId: 'a', amountMinor: Number.MAX_SAFE_INTEGER, status: 'pending' },
    ])).toThrow(/exceeds the supported amount/);
  });
});
