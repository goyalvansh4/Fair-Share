import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const noStore = { 'Cache-Control': 'no-store' };

// Spaces on the platform, with activity numbers, for the super-admin console. ?deleted=1 lists deleted spaces and
// ?slug=... returns one space (used when opening it). Requires an unlocked console; the database enforces it too.
export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401, headers: noStore });
    const { data: elevated } = await supabase.rpc('is_platform_admin');
    if (elevated !== true) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: noStore });

    const params = new URL(request.url).searchParams;
    const slug = params.get('slug');
    if (slug) {
      const { data } = await supabase
        .from('organizations')
        .select('id,name,slug,type,currency,status,created_at')
        .eq('slug', slug)
        .is('deleted_at', null)
        .maybeSingle();
      return data
        ? NextResponse.json({ organization: data }, { headers: noStore })
        : NextResponse.json({ error: 'Organization not found' }, { status: 404, headers: noStore });
    }

    const { data, error } = await supabase.rpc('admin_list_organizations', { p_deleted: params.get('deleted') === '1' });
    if (error) {
      const missing = error.code === 'PGRST202';
      return NextResponse.json({ error: missing ? 'The console needs the latest database update. Apply the pending migrations.' : 'Unable to load spaces' }, { status: missing ? 503 : 400, headers: noStore });
    }
    return NextResponse.json({ organizations: data ?? [] }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500, headers: noStore });
  }
}
