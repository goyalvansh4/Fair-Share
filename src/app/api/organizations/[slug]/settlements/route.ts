import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const createSettlementSchema = z.object({
  from_member_id: z.uuid(),
  to_member_id: z.uuid(),
  amount_minor: z.number().int().positive().safe(),
  note: z.string().trim().max(1000).optional(),
}).refine(value => value.from_member_id !== value.to_member_id, {
  message: 'Sender and recipient must be different members',
  path: ['to_member_id'],
});

type RouteContext = { params: Promise<{ slug: string }> };

async function getOrganization(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>, slug: string) {
  return supabase.from('organizations').select('id').eq('slug', slug).is('deleted_at', null).maybeSingle();
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { slug } = await context.params;
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const { data: organization, error: organizationError } = await getOrganization(supabase, slug);
    if (organizationError || !organization) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });

    const { data, error } = await supabase.from('settlements')
      .select('id,from_member_id,to_member_id,amount_minor,currency,status,note,created_by,confirmed_by,confirmed_at,created_at')
      .eq('organization_id', organization.id)
      .order('created_at', { ascending: false });
    if (error) return NextResponse.json({ error: 'Unable to load settlements' }, { status: 400 });
    return NextResponse.json({ settlements: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { slug } = await context.params;
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const parsed = createSettlementSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid settlement details', details: parsed.error.flatten() }, { status: 422 });
    if (parsed.data.from_member_id !== user.id) return NextResponse.json({ error: 'Only the member who paid can record this transfer' }, { status: 403 });

    const { data: organization, error: organizationError } = await getOrganization(supabase, slug);
    if (organizationError || !organization) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    const { data, error } = await supabase.rpc('record_settlement', {
      p_organization_id: organization.id,
      p_from_member_id: parsed.data.from_member_id,
      p_to_member_id: parsed.data.to_member_id,
      p_amount_minor: parsed.data.amount_minor,
      p_note: parsed.data.note ?? null,
    });
    if (error) {
      const forbidden = error.code === '42501';
      return NextResponse.json({ error: forbidden ? 'You do not have permission to record this transfer' : 'Unable to record transfer; verify the current balance and participants' }, { status: forbidden ? 403 : 422 });
    }
    return NextResponse.json({ settlement_id: data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}
