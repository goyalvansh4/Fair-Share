import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const expenseSchema = z.object({
  title: z.string().trim().min(1).max(140),
  description: z.string().max(3000).optional(),
  amount_minor: z.number().int().positive().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/).default('INR'),
  expense_date: z.iso.date(),
  payer_id: z.uuid(),
  category: z.enum(['food','rent','groceries','transport','accommodation','utilities','shopping','entertainment','medical','travel','miscellaneous']).default('miscellaneous'),
  split_method: z.enum(['equal','custom','percentage','weighted','per_day']).default('equal'),
  // 'group' splits equally across everyone in the group (calculated by the database); no splits are sent.
  split_scope: z.enum(['selected', 'group']).default('selected'),
  splits: z.array(z.object({ member_id: z.uuid(), amount_minor: z.number().int().nonnegative().safe() })).max(200).default([]),
}).superRefine((value, ctx) => {
  if (value.split_scope === 'group') return;
  if (!value.splits.length) ctx.addIssue({ code: 'custom', message: 'Choose at least one person to split between', path: ['splits'] });
  const ids = value.splits.map(s => s.member_id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Split participants must be unique', path: ['splits'] });
  if (value.splits.reduce((sum, s) => sum + s.amount_minor, 0) !== value.amount_minor) ctx.addIssue({ code: 'custom', message: 'Split amounts must add up to the expense total', path: ['splits'] });
});

export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const { data: organization, error: orgError } = await supabase.from('organizations').select('id').eq('slug', slug).is('deleted_at', null).maybeSingle();
    if (orgError || !organization) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    const columns = 'id,title,description,amount_minor,currency,expense_date,payer_id,category,split_method,status,created_by,created_at,updated_at,expense_splits(member_id,amount_minor)';
    const load = (select: string) => supabase.from('expenses').select(select).eq('organization_id', organization.id).eq('status', 'active').is('deleted_at', null).order('expense_date', { ascending: false });
    let { data, error } = await load(columns + ',split_scope');
    // Databases that have not applied the group-expense migration yet still work; everything is "selected people".
    if (error?.code === '42703') ({ data, error } = await load(columns));
    if (error) return NextResponse.json({ error: 'Unable to load expenses' }, { status: 400 });
    return NextResponse.json({ expenses: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const parsed = expenseSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid expense details', details: parsed.error.flatten() }, { status: 422 });
    const { data: organization, error: orgError } = await supabase.from('organizations').select('id,currency').eq('slug', slug).is('deleted_at', null).maybeSingle();
    if (orgError || !organization) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    const expense = parsed.data;
    if (expense.currency !== organization.currency) return NextResponse.json({ error: 'Expense currency must match the organization currency in this version' }, { status: 422 });
    const { data: expenseId, error } = expense.split_scope === 'group'
      ? await supabase.rpc('create_group_expense', {
        p_organization_id: organization.id,
        p_title: expense.title,
        p_description: expense.description ?? null,
        p_amount_minor: expense.amount_minor,
        p_currency: expense.currency,
        p_expense_date: expense.expense_date,
        p_payer_id: expense.payer_id,
        p_category: expense.category,
      })
      : await supabase.rpc('create_expense_with_splits', {
        p_organization_id: organization.id,
        p_title: expense.title,
        p_description: expense.description ?? null,
        p_amount_minor: expense.amount_minor,
        p_currency: expense.currency,
        p_expense_date: expense.expense_date,
        p_payer_id: expense.payer_id,
        p_category: expense.category,
        p_split_method: expense.split_method,
        p_splits: expense.splits.map(s => ({ member_id: s.member_id, amount_minor: s.amount_minor })),
      });
    if (error) {
      const forbidden = error.code === '42501';
      const missing = error.code === 'PGRST202';
      return NextResponse.json({ error: forbidden ? 'You do not have permission to create this expense' : missing ? 'Group expenses need the latest database update. Ask an admin to apply the pending migrations.' : 'Unable to save expense; verify participants and split totals' }, { status: forbidden ? 403 : missing ? 503 : 422 });
    }
    return NextResponse.json({ expense_id: expenseId }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}
