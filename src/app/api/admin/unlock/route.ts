import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ADMIN_ELEVATION_MINUTES, consolePasswordConfigured, verifyConsolePassword } from '@/lib/admin/console-password';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseServiceClient } from '@/lib/supabase/service';

const noStore = { 'Cache-Control': 'no-store' };
const bodySchema = z.object({ password: z.string().min(1).max(200) });

// Unlock the super-admin console. The password is checked here on the server; on success the database stores a
// short elevation for this account, which is what actually grants the powers (see migration 0013).
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401, headers: noStore });
    // Accounts that are not platform admins get the same answer as a missing page.
    const { data: platformAdmin } = await supabase.rpc('is_platform_admin_account');
    if (platformAdmin !== true) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: noStore });
    if (!consolePasswordConfigured()) {
      return NextResponse.json({ error: 'The admin console is not configured. Set ADMIN_CONSOLE_PASSWORD (at least 12 characters).' }, { status: 503, headers: noStore });
    }
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Enter the console password.' }, { status: 422, headers: noStore });

    const service = createSupabaseServiceClient();
    // The attempt is counted (and the row locked) BEFORE the password is checked, so parallel guesses cannot slip
    // past the lockout. If the throttle itself fails, the console stays closed.
    const { data: lockedUntil, error: throttleError } = await service.rpc('admin_unlock_begin', { p_user_id: user.id });
    if (throttleError) return NextResponse.json({ error: 'The console is temporarily unavailable.' }, { status: 503, headers: noStore });
    if (lockedUntil) {
      const minutes = Math.max(1, Math.ceil((new Date(String(lockedUntil)).getTime() - Date.now()) / 60000));
      return NextResponse.json({ error: `Too many wrong attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.` }, { status: 429, headers: noStore });
    }

    const valid = await verifyConsolePassword(parsed.data.password);
    if (!valid) {
      await new Promise(resolve => setTimeout(resolve, 600)); // slows down guessing
      return NextResponse.json({ error: 'Incorrect password.' }, { status: 401, headers: noStore });
    }
    await service.rpc('admin_unlock_record', { p_user_id: user.id, p_success: true });
    const { data: expiresAt, error } = await service.rpc('grant_admin_elevation', { p_user_id: user.id, p_minutes: ADMIN_ELEVATION_MINUTES });
    if (error) return NextResponse.json({ error: 'Unable to unlock the console.' }, { status: 500, headers: noStore });
    return NextResponse.json({ unlocked: true, expires_at: expiresAt }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500, headers: noStore });
  }
}

// Lock the console again immediately.
export async function DELETE() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401, headers: noStore });
    const { data: platformAdmin } = await supabase.rpc('is_platform_admin_account');
    if (platformAdmin !== true) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: noStore });
    await createSupabaseServiceClient().rpc('revoke_admin_elevation', { p_user_id: user.id });
    return NextResponse.json({ unlocked: false }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500, headers: noStore });
  }
}
