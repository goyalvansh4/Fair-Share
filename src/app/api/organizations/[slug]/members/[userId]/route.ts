import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type RouteContext = { params: Promise<{ slug: string; userId: string }> };

// Either field may be sent; share_from null means "shares group expenses from the beginning".
const memberUpdateSchema = z.object({
  // 'owner' hands the space over to this member (owner only).
  role: z.enum(['owner', 'admin', 'member', 'viewer']).optional(),
  share_from: z.iso.date().nullable().optional(),
}).refine(value => value.role !== undefined || value.share_from !== undefined, { message: 'Nothing to update' });

function statusFor(code: string | undefined): number {
  if (code === '42501') return 403;
  if (code === '22023') return 422;
  return 400;
}

async function resolveContext(context: RouteContext) {
  const { slug, userId } = await context.params;
  const parsedUserId = z.uuid().safeParse(userId);
  if (!parsedUserId.success) return { error: NextResponse.json({ error: 'Invalid member identifier' }, { status: 422 }) };
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { error: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  const { data: organization } = await supabase
    .from('organizations').select('id').eq('slug', slug).is('deleted_at', null).maybeSingle();
  if (!organization) return { error: NextResponse.json({ error: 'Organization not found' }, { status: 404 }) };
  return { supabase, organizationId: organization.id, userId: parsedUserId.data };
}

// Change a member's role (admins only; the last admin cannot be demoted).
export async function PATCH(request: Request, context: RouteContext) {
  try {
    const resolved = await resolveContext(context);
    if ('error' in resolved) return resolved.error;
    const parsed = memberUpdateSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Choose a valid role or date' }, { status: 422 });
    if (parsed.data.role === 'owner') {
      const { error } = await resolved.supabase.rpc('transfer_organization_ownership', {
        p_organization_id: resolved.organizationId,
        p_new_owner_id: resolved.userId,
      });
      if (error) {
        const missing = error.code === 'PGRST202';
        return NextResponse.json({
          error: missing ? 'This action needs the latest database update. Ask an admin to apply the pending migrations.' : error.message,
        }, { status: missing ? 503 : statusFor(error.code) });
      }
    } else if (parsed.data.role !== undefined) {
      const { error } = await resolved.supabase.rpc('set_member_role', {
        p_organization_id: resolved.organizationId,
        p_user_id: resolved.userId,
        p_role: parsed.data.role,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: statusFor(error.code) });
    }
    if (parsed.data.share_from !== undefined) {
      const { error } = await resolved.supabase.rpc('set_member_share_from', {
        p_organization_id: resolved.organizationId,
        p_user_id: resolved.userId,
        p_share_from: parsed.data.share_from,
      });
      if (error) {
        const missing = error.code === 'PGRST202';
        return NextResponse.json({
          error: missing ? 'This action needs the latest database update. Ask an admin to apply the pending migrations.' : error.message,
        }, { status: missing ? 503 : statusFor(error.code) });
      }
    }
    return NextResponse.json({ role: parsed.data.role ?? null, share_from: parsed.data.share_from ?? null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}

// Remove a member (admins) or leave the space (self). The member must be settled up.
export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const resolved = await resolveContext(context);
    if ('error' in resolved) return resolved.error;
    const { error } = await resolved.supabase.rpc('remove_organization_member', {
      p_organization_id: resolved.organizationId,
      p_user_id: resolved.userId,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: statusFor(error.code) });
    return NextResponse.json({ status: 'removed' });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}
