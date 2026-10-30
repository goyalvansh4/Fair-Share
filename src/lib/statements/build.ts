import {
  applySettlementAdjustments, type Balance, calculateBalances, suggestSettlements, type Transfer,
} from '../expenses/engine';
import { type MonthRange } from './period';

export type StatementMember = { id: string; name: string; active: boolean };

export type StatementExpense = {
  id: string;
  title: string;
  category: string;
  expense_date: string;
  payer_id: string;
  amount_minor: number;
  splits: { member_id: string; amount_minor: number }[];
};

export type StatementSettlement = {
  from_member_id: string;
  to_member_id: string;
  amount_minor: number;
  status: 'pending' | 'confirmed' | 'cancelled';
  /** Calendar date (YYYY-MM-DD) the transfer was recorded. */
  date: string;
};

export type StatementInput = {
  organization: { name: string; currency: string };
  period: MonthRange;
  members: StatementMember[];
  /** Every live expense dated on or before period.to (older ones feed the closing balance). */
  expenses: StatementExpense[];
  /** Every transfer recorded on or before period.to. */
  settlements: StatementSettlement[];
  generatedAt: Date;
};

export type MemberLine = {
  memberId: string;
  name: string;
  active: boolean;
  paidMinor: number;
  shareMinor: number;
  /** Paid minus share for this month only. */
  periodNetMinor: number;
  /** What is still owed (negative) or due back (positive) after everything up to period end. */
  closingNetMinor: number;
};

export type Statement = {
  organizationName: string;
  currency: string;
  period: MonthRange;
  generatedAt: Date;
  totalSpendMinor: number;
  expenseCount: number;
  memberLines: MemberLine[];
  expenses: (StatementExpense & { payerName: string })[];
  payments: (StatementSettlement & { fromName: string; toName: string })[];
  transfers: (Transfer & { fromName: string; toName: string })[];
  /** Set when the ledger could not be reconciled; balances are omitted rather than shown wrong. */
  warning: string | null;
};

/** Builds everything a statement shows. Pure: no I/O, so it is easy to test and reuse for the PDF and the email. */
export function buildStatement(input: StatementInput): Statement {
  const { period } = input;
  const nameOf = (id: string) => input.members.find(member => member.id === id)?.name ?? 'Former member';
  const inPeriod = (date: string) => date >= period.from && date <= period.to;

  const periodExpenses = input.expenses
    .filter(expense => inPeriod(expense.expense_date))
    .sort((a, b) => a.expense_date.localeCompare(b.expense_date) || a.title.localeCompare(b.title));
  const upToEnd = input.expenses.filter(expense => expense.expense_date <= period.to);
  const settlementsUpToEnd = input.settlements.filter(settlement => settlement.date <= period.to);

  const paid = new Map<string, number>();
  const share = new Map<string, number>();
  for (const expense of periodExpenses) {
    paid.set(expense.payer_id, (paid.get(expense.payer_id) ?? 0) + expense.amount_minor);
    for (const split of expense.splits) share.set(split.member_id, (share.get(split.member_id) ?? 0) + split.amount_minor);
  }

  let closing: Balance[] = [];
  let warning: string | null = null;
  try {
    const base = calculateBalances(
      input.members.map(member => member.id),
      upToEnd.map(expense => ({
        payerId: expense.payer_id,
        totalMinor: expense.amount_minor,
        splits: expense.splits.map(split => ({ memberId: split.member_id, amountMinor: split.amount_minor })),
      })),
    );
    closing = applySettlementAdjustments(base, settlementsUpToEnd.map(settlement => ({
      fromMemberId: settlement.from_member_id,
      toMemberId: settlement.to_member_id,
      amountMinor: settlement.amount_minor,
      status: settlement.status,
    })));
  } catch (error) {
    warning = error instanceof Error ? error.message : 'Balances could not be calculated.';
  }

  const closingById = new Map(closing.map(balance => [balance.memberId, balance.netMinor]));
  const memberLines = input.members
    .map<MemberLine>(member => {
      const paidMinor = paid.get(member.id) ?? 0;
      const shareMinor = share.get(member.id) ?? 0;
      return {
        memberId: member.id,
        name: member.name,
        active: member.active,
        paidMinor,
        shareMinor,
        periodNetMinor: paidMinor - shareMinor,
        closingNetMinor: closingById.get(member.id) ?? 0,
      };
    })
    // Show active members, plus anyone who was involved this month or still has a balance.
    .filter(line => line.active || line.paidMinor !== 0 || line.shareMinor !== 0 || line.closingNetMinor !== 0)
    .sort((a, b) => b.closingNetMinor - a.closingNetMinor || a.name.localeCompare(b.name));

  let transfers: Statement['transfers'] = [];
  if (!warning) {
    try {
      transfers = suggestSettlements(closing).map(transfer => ({
        ...transfer,
        fromName: nameOf(transfer.fromMemberId),
        toName: nameOf(transfer.toMemberId),
      }));
    } catch (error) {
      warning = error instanceof Error ? error.message : 'Suggested payments could not be calculated.';
    }
  }

  return {
    organizationName: input.organization.name,
    currency: input.organization.currency,
    period,
    generatedAt: input.generatedAt,
    totalSpendMinor: periodExpenses.reduce((sum, expense) => sum + expense.amount_minor, 0),
    expenseCount: periodExpenses.length,
    memberLines,
    expenses: periodExpenses.map(expense => ({ ...expense, payerName: nameOf(expense.payer_id) })),
    payments: input.settlements
      .filter(settlement => inPeriod(settlement.date))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(settlement => ({ ...settlement, fromName: nameOf(settlement.from_member_id), toName: nameOf(settlement.to_member_id) })),
    transfers,
    warning,
  };
}
