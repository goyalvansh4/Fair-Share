import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const bulkDeleteSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  include_settlements: z.boolean().default(false),
}).refine(value => value.from <= value.to, { message: 'The start date must be on or before the end date', path: ['from'] });

// Admin reset: delete every expense dated within the range (inclusive).
export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const parsed = bulkDeleteSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Choose a valid date range' }, { status: 422 });
    const { data: organization } = await supabase
      .from('organizations').select('id').eq('slug', slug).is('deleted_at', null).maybeSingle();
    if (!organization) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    const { data: count, error } = await supabase.rpc('void_expenses_in_range', {
      p_organization_id: organization.id,
      p_from: parsed.data.from,
      p_to: parsed.data.to,
      p_include_settlements: parsed.data.include_settlements,
    });
    if (error) {
      const forbidden = error.code === '42501';
      return NextResponse.json({ error: forbidden ? 'Only admins can delete expenses in bulk' : error.message }, { status: forbidden ? 403 : 422 });
    }
    return NextResponse.json({ deleted: count ?? 0 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}
