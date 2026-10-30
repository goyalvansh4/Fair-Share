import { NextResponse } from 'next/server';
import { z } from 'zod';
import { hashInvitationToken } from '@/lib/invitations/token';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const acceptanceSchema = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) });

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Sign in to accept this invitation' }, { status: 401 });
    const parsed = acceptanceSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid invitation link' }, { status: 422 });
    const { data: slug, error } = await supabase.rpc('accept_organization_invitation', {
      p_token_hash: await hashInvitationToken(parsed.data.token),
    });
    if (error) {
      const forbidden = error.code === '42501';
      return NextResponse.json({
        error: forbidden
          ? 'This invite belongs to a different email. Sign in with the invited email address.'
          : 'This invitation is invalid, expired, or has already been used.',
      }, { status: forbidden ? 403 : 422 });
    }
    return NextResponse.json({ organization_slug: slug });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}
