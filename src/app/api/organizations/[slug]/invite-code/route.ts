import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isValidSecretCode, normalizeInviteCode } from '@/lib/invitations/code';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const noStore = { 'Cache-Control': 'no-store' };
type RouteContext = { params: Promise<{ slug: string }> };
type Resolved = { supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>; organizationId: string };

async function resolve(context: RouteContext): Promise<Resolved | { error: NextResponse }> {
  const { slug } = await context.params;
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { error: NextResponse.json({ error: 'Authentication required' }, { status: 401, headers: noStore }) };
  const { data: organization } = await supabase.from('organizations').select('id').eq('slug', slug).is('deleted_at', null).maybeSingle();
  if (!organization) return { error: NextResponse.json({ error: 'Organization not found' }, { status: 404, headers: noStore }) };
  return { supabase, organizationId: organization.id };
}

function failure(code: string | undefined, message: string) {
  if (code === 'PGRST202') return NextResponse.json({ error: 'Invite codes need the latest database update. Ask an admin to apply the pending migrations.' }, { status: 503, headers: noStore });
  return NextResponse.json({ error: code === '42501' ? 'You are not allowed to do that.' : message }, { status: code === '42501' ? 403 : 422, headers: noStore });
}

// The invite code is visible to every member. The secret code reaches only real owners and admins (never a super admin).
async function readDetails(resolved: Resolved) {
  const { data: code, error } = await resolved.supabase.rpc('get_organization_invite_code', { p_organization_id: resolved.organizationId });
  if (error) return { ok: false as const, errorCode: error.code };
  const { data: secret } = await resolved.supabase.rpc('get_organization_secret_code', { p_organization_id: resolved.organizationId });
  return { ok: true as const, code: (code as string | null) ?? null, secret: (secret as string | null) ?? null };
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const resolved = await resolve(context);
    if ('error' in resolved) return resolved.error;
    const details = await readDetails(resolved);
    if (!details.ok) return failure(details.errorCode, 'Unable to load the invite code.');
    return NextResponse.json({ code: details.code, secret: details.secret }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500, headers: noStore });
  }
}

// Owner and admins. part "code": enable = fresh invite code, disable = turn joining by code off.
// part "secret": enable = fresh secret code (or the custom one given), disable = turn the secret off.
export async function POST(request: Request, context: RouteContext) {
  try {
    const resolved = await resolve(context);
    if ('error' in resolved) return resolved.error;
    const parsed = z.object({
      enable: z.boolean(),
      part: z.enum(['code', 'secret']).default('code'),
      custom: z.string().max(60).optional(),
    }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 422, headers: noStore });
    const { enable, part, custom } = parsed.data;

    let outcome;
    if (part === 'secret' && enable && custom) {
      if (!isValidSecretCode(custom)) return NextResponse.json({ error: 'The secret code must be 8 to 32 letters or digits.' }, { status: 422, headers: noStore });
      outcome = await resolved.supabase.rpc('set_organization_secret_code', { p_organization_id: resolved.organizationId, p_secret: normalizeInviteCode(custom) });
    } else if (part === 'secret') {
      outcome = await resolved.supabase.rpc('rotate_organization_secret_code', { p_organization_id: resolved.organizationId, p_enable: enable });
    } else {
      outcome = await resolved.supabase.rpc('rotate_organization_invite_code', { p_organization_id: resolved.organizationId, p_enable: enable });
    }
    if (outcome.error) return failure(outcome.error.code, outcome.error.message || 'Unable to change the code.');
    const details = await readDetails(resolved);
    if (!details.ok) return failure(details.errorCode, 'Unable to load the invite code.');
    return NextResponse.json({ code: details.code, secret: details.secret }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500, headers: noStore });
  }
}
