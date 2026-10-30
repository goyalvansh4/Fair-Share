import type { SupabaseClient } from '@supabase/supabase-js';
import { buildStatement, type Statement, type StatementInput } from './build';
import { composeStatementEmail } from './compose';
import { sendEmails } from './mailer';
import { renderStatementPdf } from './pdf';
import { type MonthRange } from './period';

export type StatementOrganization = { id: string; name: string; slug: string; currency: string; timezone: string };

const PAGE = 1000;

// PostgREST returns at most 1000 rows per request, so large spaces are read page by page.
async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

/** Calendar date (YYYY-MM-DD) of an instant in the space's timezone. */
export function localDateString(iso: string, timeZone: string): string {
  let zone = timeZone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { zone = 'UTC'; }
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** Reads everything a statement needs. Works with a signed-in client (row-level security applies) or the service client. */
export async function loadStatementInput(supabase: SupabaseClient, organization: StatementOrganization, month: MonthRange): Promise<StatementInput> {
  const { data: memberRows, error: memberError } = await supabase
    .from('organization_members').select('user_id,status').eq('organization_id', organization.id).in('status', ['active', 'removed']);
  if (memberError) throw new Error(memberError.message);
  const ids = (memberRows ?? []).map(row => row.user_id as string);
  const { data: profiles } = ids.length ? await supabase.from('profiles').select('id,display_name').in('id', ids) : { data: [] };
  const nameById = new Map((profiles ?? []).map(profile => [profile.id as string, String(profile.display_name ?? '').trim()]));

  const expenses = await fetchAll<{
    id: string; title: string; category: string; expense_date: string; payer_id: string; amount_minor: number;
    expense_splits: { member_id: string; amount_minor: number }[];
  }>((from, to) => supabase
    .from('expenses')
    .select('id,title,category,expense_date,payer_id,amount_minor,expense_splits(member_id,amount_minor)')
    .eq('organization_id', organization.id).eq('status', 'active').is('deleted_at', null)
    .lte('expense_date', month.to).order('expense_date').order('id').range(from, to));

  const settlements = await fetchAll<{ from_member_id: string; to_member_id: string; amount_minor: number; status: 'pending' | 'confirmed' | 'cancelled'; created_at: string }>(
    (from, to) => supabase
      .from('settlements').select('from_member_id,to_member_id,amount_minor,status,created_at')
      .eq('organization_id', organization.id).order('created_at').order('id').range(from, to));

  return {
    organization: { name: organization.name, currency: organization.currency },
    period: month,
    members: (memberRows ?? []).map(row => ({
      id: row.user_id as string,
      name: nameById.get(row.user_id as string) || (row.status === 'removed' ? 'Former member' : 'Member'),
      active: row.status === 'active',
    })),
    expenses: expenses.map(expense => ({
      id: expense.id, title: expense.title, category: expense.category, expense_date: expense.expense_date,
      payer_id: expense.payer_id, amount_minor: expense.amount_minor,
      splits: expense.expense_splits.map(split => ({ member_id: split.member_id, amount_minor: split.amount_minor })),
    })),
    settlements: settlements.map(settlement => ({
      from_member_id: settlement.from_member_id, to_member_id: settlement.to_member_id, amount_minor: settlement.amount_minor,
      status: settlement.status, date: localDateString(settlement.created_at, organization.timezone),
    })),
    generatedAt: new Date(),
  };
}

export async function buildStatementPdf(supabase: SupabaseClient, organization: StatementOrganization, month: MonthRange): Promise<{ statement: Statement; pdf: Uint8Array }> {
  const statement = buildStatement(await loadStatementInput(supabase, organization, month));
  return { statement, pdf: await renderStatementPdf(statement) };
}

/** Builds the statement once and emails it (with the PDF attached) to each address separately. */
export async function emailStatement(
  supabase: SupabaseClient,
  organization: StatementOrganization,
  month: MonthRange,
  recipients: string[],
): Promise<{ sent: number; failed: { to: string; reason: string }[] }> {
  if (!recipients.length) throw new Error('There is nobody to send the statement to. Check the recipients in the settings.');
  const { statement, pdf } = await buildStatementPdf(supabase, organization, month);
  const content = composeStatementEmail(statement);
  const filename = `fairshare-${organization.slug}-${month.key}.pdf`;
  return sendEmails(recipients.map(to => ({ to, ...content, attachment: { filename, content: pdf } })));
}
