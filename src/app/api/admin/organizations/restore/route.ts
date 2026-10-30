import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const noStore = { 'Cache-Control': 'no-store' };

// Restore deleted spaces. Super-admin console only.
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401, headers: noStore });
    const parsed = z.object({ ids: z.array(z.uuid()).min(1).max(200) }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Choose between 1 and 200 spaces.' }, { status: 422, headers: noStore });
    const { data, error } = await supabase.rpc('admin_restore_organizations', { p_ids: parsed.data.ids });
    if (error) return NextResponse.json({ error: error.code === '42501' ? 'The admin console is locked.' : error.message }, { status: error.code === '42501' ? 403 : 422, headers: noStore });
    return NextResponse.json({ restored: data ?? 0 }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500, headers: noStore });
  }
}
