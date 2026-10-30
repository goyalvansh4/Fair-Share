import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const noStore = { 'Cache-Control': 'no-store' };

const updateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  // Omit to keep the current description.
  description: z.string().max(1000).optional(),
  type: z.enum(['trip', 'room', 'party', 'personal', 'custom']),
  timezone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
  }, 'Unknown timezone'),
  status: z.enum(['active', 'archived', 'suspended']),
});

// Edit a space from the super-admin console (name, type, timezone, status). Slug, currency and owner stay fixed.
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const parsedId = z.uuid().safeParse(id);
    if (!parsedId.success) return NextResponse.json({ error: 'Invalid space' }, { status: 422, headers: noStore });
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401, headers: noStore });
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Check the details' }, { status: 422, headers: noStore });

    const { error } = await supabase.rpc('admin_update_organization', {
      p_organization_id: parsedId.data,
      p_name: parsed.data.name,
      p_description: parsed.data.description ?? null,
      p_type: parsed.data.type,
      p_timezone: parsed.data.timezone,
      p_status: parsed.data.status,
    });
    if (error) return NextResponse.json({ error: error.code === '42501' ? 'The admin console is locked.' : error.message }, { status: error.code === '42501' ? 403 : 422, headers: noStore });
    return NextResponse.json({ status: 'updated' }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500, headers: noStore });
  }
}
