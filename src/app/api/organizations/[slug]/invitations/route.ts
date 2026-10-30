import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createInvitationToken, hashInvitationToken } from '@/lib/invitations/token';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const invitationSchema = z.object({
  // Omit the email to create an open invite link that anyone signed in can use.
  email: z.email().trim().toLowerCase().optional(),
  role: z.enum(['member', 'viewer']).default('member'),
});

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const parsed = invitationSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid invitation details', details: parsed.error.flatten() }, { status: 422 });

    const { data: organization, error: organizationError } = await supabase
      .from('organizations').select('id').eq('slug', slug).is('deleted_at', null).maybeSingle();
    if (organizationError || !organization) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });

    const token = createInvitationToken();
    const tokenHash = await hashInvitationToken(token);
    const { data: invitationId, error } = parsed.data.email
      ? await supabase.rpc('create_organization_invitation', {
        p_organization_id: organization.id,
        p_email: parsed.data.email,
        p_role: parsed.data.role,
        p_token_hash: tokenHash,
      })
      : await supabase.rpc('create_organization_invite_link', {
        p_organization_id: organization.id,
        p_role: parsed.data.role,
        p_token_hash: tokenHash,
      });
    if (error) {
      const forbidden = error.code === '42501';
      const conflict = error.code === '23505';
      return NextResponse.json({
        error: forbidden
          ? 'Only organization admins can invite members'
          : conflict
            ? 'An active invitation already exists for this email'
            : 'Unable to create invitation; verify the email and membership',
      }, { status: forbidden ? 403 : conflict ? 409 : 422 });
    }

    return NextResponse.json({ invitation: { id: invitationId, token, expires_in_days: 7 } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}
