import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const categories = ['food','rent','groceries','transport','accommodation','utilities','shopping','entertainment','medical','travel','miscellaneous'] as const;

const editSchema = z.object({
  title: z.string().trim().min(1).max(140),
  description: z.string().max(3000).optional(),
  amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expense_date: z.iso.date(),
  payer_id: z.uuid(),
  category: z.enum(categories),
  split_method: z.enum(['equal', 'custom', 'percentage', 'weighted', 'per_day']),
  split_scope: z.enum(['selected', 'group']).default('selected'),
  // Version the editor last saw; a mismatch means someone else changed the expense meanwhile.
  expected_updated_at: z.string().min(1).optional(),
  splits: z.array(z.object({ member_id: z.uuid(), amount_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })).max(200).default([]),
}).superRefine((value, ctx) => {
  if (value.split_scope === 'group') return;
  if (!value.splits.length) ctx.addIssue({ code: 'custom', message: 'Choose at least one person to split between', path: ['splits'] });
  const ids = value.splits.map(split => split.member_id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Split participants must be unique', path: ['splits'] });
  if (value.splits.reduce((sum, split) => sum + split.amount_minor, 0) !== value.amount_minor) ctx.addIssue({ code: 'custom', message: 'Split amounts must add up to the expense total', path: ['splits'] });
});

export async function PATCH(request: Request, context: { params: Promise<{ slug: string; expenseId: string }> }) {
  try {
    const { slug, expenseId } = await context.params;
    const parsedId = z.uuid().safeParse(expenseId);
    if (!parsedId.success) return NextResponse.json({ error: 'Invalid expense identifier' }, { status: 422 });
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const parsed = editSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid expense details' }, { status: 422 });
    const { data: organization } = await supabase
      .from('organizations').select('id').eq('slug', slug).is('deleted_at', null).maybeSingle();
    if (!organization) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    const { data: expense } = await supabase
      .from('expenses').select('id').eq('id', parsedId.data).eq('organization_id', organization.id).maybeSingle();
    if (!expense) return NextResponse.json({ error: 'Expense not found' }, { status: 404 });

    const input = parsed.data;
    const common = {
      p_expense_id: parsedId.data,
      p_expected_updated_at: input.expected_updated_at ?? null,
      p_title: input.title,
      p_description: input.description ?? null,
      p_amount_minor: input.amount_minor,
      p_expense_date: input.expense_date,
      p_payer_id: input.payer_id,
      p_category: input.category,
    };
    const { error } = input.split_scope === 'group'
      ? await supabase.rpc('update_group_expense', common)
      : await supabase.rpc('update_expense_with_splits', {
        ...common,
        p_split_method: input.split_method,
        p_splits: input.splits.map(split => ({ member_id: split.member_id, amount_minor: split.amount_minor })),
      });
    if (error) {
      const status = error.code === '42501' ? 403 : error.code === '40001' ? 409 : error.code === 'PGRST202' ? 503 : 422;
      const message = error.code === '42501'
        ? 'Only the author or an admin can edit this expense'
        : error.code === 'PGRST202'
          ? 'This action needs the latest database update. Ask an admin to apply the pending migrations.'
          : error.message;
      return NextResponse.json({ error: message }, { status });
    }
    return NextResponse.json({ status: 'updated' });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ slug: string; expenseId: string }> }) {
  try {
    const { slug, expenseId } = await context.params;
    const parsedId = z.uuid().safeParse(expenseId);
    if (!parsedId.success) return NextResponse.json({ error: 'Invalid expense identifier' }, { status: 422 });

    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

    const { data: organization, error: organizationError } = await supabase
      .from('organizations').select('id').eq('slug', slug).is('deleted_at', null).maybeSingle();
    if (organizationError || !organization) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });

    const { data: expense } = await supabase
      .from('expenses').select('id').eq('id', parsedId.data).eq('organization_id', organization.id).maybeSingle();
    if (!expense) return NextResponse.json({ error: 'Expense not found' }, { status: 404 });

    const { error } = await supabase.rpc('void_expense', { p_expense_id: parsedId.data });
    if (error) {
      const forbidden = error.code === '42501';
      return NextResponse.json({ error: forbidden ? 'Only the author or an admin can delete this expense' : 'Unable to delete this expense' }, { status: forbidden ? 403 : 422 });
    }
    return NextResponse.json({ status: 'deleted' });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}
