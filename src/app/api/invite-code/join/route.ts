import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isValidInviteCode, isValidSecretCode, normalizeInviteCode } from '@/lib/invitations/code';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const noStore = { 'Cache-Control': 'no-store' };
const bodySchema = z.object({
  code: z.string().max(40).refine(isValidInviteCode, 'Enter the 12-character invite code.'),
  // The second factor. Optional only because some spaces turn it off; the database decides whether it is required.
  secret: z.string().max(40).refine(value => value.trim() === '' || isValidSecretCode(value), 'The secret code has 10 characters.').optional(),
});

// Join a space with its invite code. Wrong guesses are limited per person in the database.
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Sign in to join a space.' }, { status: 401, headers: noStore });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Enter the 12-character invite code.' }, { status: 422, headers: noStore });

    const { data: slug, error } = await supabase.rpc('join_organization_by_code', {
      p_code: normalizeInviteCode(parsed.data.code),
      p_secret: parsed.data.secret?.trim() ? normalizeInviteCode(parsed.data.secret) : null,
    });
    if (error) {
      const status = error.code === '54000' ? 429 : error.code === '42501' ? 403 : error.code === '23505' ? 409 : error.code === 'PGRST202' ? 503 : 422;
      const message = error.code === 'PGRST202' ? 'Joining with a code needs the latest database update. Ask an admin to apply the pending migrations.' : error.message;
      return NextResponse.json({ error: message }, { status, headers: noStore });
    }
    return NextResponse.json({ organization_slug: slug }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500, headers: noStore });
  }
}
