import { NextResponse } from 'next/server';
import { consolePasswordConfigured } from '@/lib/admin/console-password';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const noStore = { 'Cache-Control': 'no-store' };

// Is this account a platform admin, and is the admin console currently unlocked for it?
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401, headers: noStore });
    const { data: platformAdmin } = await supabase.rpc('is_platform_admin_account');
    if (platformAdmin !== true) return NextResponse.json({ platform_admin: false }, { headers: noStore });
    const { data: expiresAt } = await supabase.rpc('admin_elevation_expires');
    return NextResponse.json({
      platform_admin: true,
      unlocked: Boolean(expiresAt),
      expires_at: expiresAt ?? null,
      configured: consolePasswordConfigured(),
    }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500, headers: noStore });
  }
}
