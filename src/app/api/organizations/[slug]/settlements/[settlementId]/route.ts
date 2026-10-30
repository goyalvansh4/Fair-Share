import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const actionSchema = z.object({ action: z.enum(['confirm', 'cancel']) });

export async function PATCH(request: Request, context: { params: Promise<{ slug: string; settlementId: string }> }) {
  try {
    const { slug, settlementId } = await context.params;
    const parsedId = z.uuid().safeParse(settlementId);
    if (!parsedId.success) return NextResponse.json({ error: 'Invalid settlement identifier' }, { status: 422 });

    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const parsed = actionSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid settlement action' }, { status: 422 });

    const { data: organization, error: organizationError } = await supabase
      .from('organizations').select('id').eq('slug', slug).is('deleted_at', null).maybeSingle();
    if (organizationError || !organization) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    // The settlement must belong to this space (the database authorizes against its own space, this keeps URL and id consistent).
    const { data: settlement } = await supabase
      .from('settlements').select('id').eq('id', parsedId.data).eq('organization_id', organization.id).maybeSingle();
    if (!settlement) return NextResponse.json({ error: 'Transfer not found' }, { status: 404 });
    const { error } = await supabase.rpc('resolve_settlement', {
      p_settlement_id: parsedId.data,
      p_action: parsed.data.action,
    });
    if (error) {
      const forbidden = error.code === '42501';
      return NextResponse.json({ error: forbidden ? 'You do not have permission to resolve this transfer' : 'Unable to resolve transfer; it may already be closed' }, { status: forbidden ? 403 : 422 });
    }
    return NextResponse.json({ status: parsed.data.action === 'confirm' ? 'confirmed' : 'cancelled' });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}
