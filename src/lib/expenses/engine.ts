export type SplitInput = { memberId: string; weight?: number };
export type Split = { memberId: string; amountMinor: number };

/** Split integer minor units deterministically. Remainder minor units go to earlier IDs. */
export function splitEqually(totalMinor: number, memberIds: string[]): Split[] {
  assertAmount(totalMinor);
  if (memberIds.length === 0) throw new Error('At least one participant is required');
  if (new Set(memberIds).size !== memberIds.length) throw new Error('Participants must be unique');
  const sorted = [...memberIds].sort((a, b) => a.localeCompare(b));
  const base = Math.floor(totalMinor / sorted.length);
  const remainder = totalMinor % sorted.length;
  return sorted.map((memberId, index) => ({ memberId, amountMinor: base + (index < remainder ? 1 : 0) }));
}

export function splitByWeights(totalMinor: number, participants: SplitInput[]): Split[] {
  assertAmount(totalMinor);
  if (!participants.length) throw new Error('At least one participant is required');
  if (new Set(participants.map(p => p.memberId)).size !== participants.length) throw new Error('Participants must be unique');
  if (participants.some(p => !Number.isFinite(p.weight ?? 1) || (p.weight ?? 1) <= 0)) throw new Error('Weights must be positive numbers');
  const totalWeight = participants.reduce((sum, p) => sum + (p.weight ?? 1), 0);
  const exact = participants.map(p => ({ memberId: p.memberId, exact: totalMinor * (p.weight ?? 1) / totalWeight }));
  const result = exact.map(p => ({ memberId: p.memberId, amountMinor: Math.floor(p.exact) }));
  const remainder = totalMinor - result.reduce((sum, p) => sum + p.amountMinor, 0);
  const ranked = exact.map((p, index) => ({ index, fraction: p.exact - Math.floor(p.exact), memberId: p.memberId }))
    .sort((a, b) => b.fraction - a.fraction || a.memberId.localeCompare(b.memberId));
  for (let i = 0; i < remainder; i++) result[ranked[i].index].amountMinor += 1;
  return result;
}

export type LedgerExpense = { payerId: string; totalMinor: number; splits: Split[] };
export type Balance = { memberId: string; paidMinor: number; shareMinor: number; netMinor: number };

export type SettlementAdjustment = {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
  status: 'pending' | 'confirmed' | 'cancelled';
};

export function calculateBalances(memberIds: string[], expenses: LedgerExpense[]): Balance[] {
  if (new Set(memberIds).size !== memberIds.length) throw new Error('Member IDs must be unique');
  const allowed = new Set(memberIds);
  const paid = new Map(memberIds.map(id => [id, 0]));
  const share = new Map(memberIds.map(id => [id, 0]));
  for (const expense of expenses) {
    if (!allowed.has(expense.payerId)) throw new Error(`Unknown payer: ${expense.payerId}`);
    assertAmount(expense.totalMinor);
    const splitTotal = expense.splits.reduce((sum, s) => sum + s.amountMinor, 0);
    if (expense.splits.some(s => !allowed.has(s.memberId) || !Number.isSafeInteger(s.amountMinor) || s.amountMinor < 0)) throw new Error('Invalid split');
    if (!Number.isSafeInteger(splitTotal)) throw new Error('Invalid split total');
    if (splitTotal !== expense.totalMinor) throw new Error('Expense total does not match allocated splits');
    const paidTotal = paid.get(expense.payerId)! + expense.totalMinor;
    if (!Number.isSafeInteger(paidTotal)) throw new Error('Member paid total exceeds the supported amount');
    paid.set(expense.payerId, paidTotal);
    for (const item of expense.splits) {
      const shareTotal = share.get(item.memberId)! + item.amountMinor;
      if (!Number.isSafeInteger(shareTotal)) throw new Error('Member share total exceeds the supported amount');
      share.set(item.memberId, shareTotal);
    }
  }
  const balances = memberIds.map(memberId => ({ memberId, paidMinor: paid.get(memberId)!, shareMinor: share.get(memberId)!, netMinor: paid.get(memberId)! - share.get(memberId)! }));
  const netTotal = balances.reduce((sum, balance) => sum + balance.netMinor, 0);
  if (!Number.isSafeInteger(netTotal)) throw new Error('Ledger total exceeds the supported amount');
  if (netTotal !== 0) throw new Error('Ledger does not reconcile: expense splits must equal expense totals');
  return balances;
}

export function applySettlementAdjustments(balances: Balance[], settlements: SettlementAdjustment[]): Balance[] {
  const netByMember = new Map(balances.map(balance => [balance.memberId, balance.netMinor]));
  for (const settlement of settlements) {
    if (settlement.status === 'cancelled') continue;
    if (settlement.fromMemberId === settlement.toMemberId
      || !netByMember.has(settlement.fromMemberId)
      || !netByMember.has(settlement.toMemberId)
      || !Number.isSafeInteger(settlement.amountMinor)
      || settlement.amountMinor <= 0) {
      throw new Error('Invalid settlement adjustment');
    }
    const fromBalance = netByMember.get(settlement.fromMemberId)! + settlement.amountMinor;
    const toBalance = netByMember.get(settlement.toMemberId)! - settlement.amountMinor;
    if (!Number.isSafeInteger(fromBalance) || !Number.isSafeInteger(toBalance)) {
      throw new Error('Settlement balance exceeds the supported amount');
    }
    netByMember.set(settlement.fromMemberId, fromBalance);
    netByMember.set(settlement.toMemberId, toBalance);
  }
  const adjusted = balances.map(balance => ({ ...balance, netMinor: netByMember.get(balance.memberId)! }));
  const netTotal = adjusted.reduce((sum, balance) => sum + balance.netMinor, 0);
  if (!Number.isSafeInteger(netTotal) || netTotal !== 0) throw new Error('Settlement adjustments do not reconcile');
  return adjusted;
}

export type Transfer = { fromMemberId: string; toMemberId: string; amountMinor: number };
export function suggestSettlements(balances: Balance[]): Transfer[] {
  const debtors = balances.filter(b => b.netMinor < 0).map(b => ({ id: b.memberId, amount: -b.netMinor })).sort((a,b) => a.id.localeCompare(b.id));
  const creditors = balances.filter(b => b.netMinor > 0).map(b => ({ id: b.memberId, amount: b.netMinor })).sort((a,b) => a.id.localeCompare(b.id));
  const transfers: Transfer[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amountMinor = Math.min(debtors[i].amount, creditors[j].amount);
    if (amountMinor > 0) transfers.push({ fromMemberId: debtors[i].id, toMemberId: creditors[j].id, amountMinor });
    debtors[i].amount -= amountMinor;
    creditors[j].amount -= amountMinor;
    if (debtors[i].amount === 0) i++;
    if (creditors[j].amount === 0) j++;
  }
  if (i !== debtors.length || j !== creditors.length) throw new Error('Balances do not reconcile');
  return transfers;
}

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Amount must be a non-negative safe integer in minor currency units');
}
