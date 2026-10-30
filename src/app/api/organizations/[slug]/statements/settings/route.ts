import { NextResponse } from 'next/server';
import { z } from 'zod';
import { emailIsConfigured } from '@/lib/statements/mailer';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const noStore = { 'Cache-Control': 'no-store' };
type RouteContext = { params: Promise<{ slug: string }> };

const settingsSchema = z.object({
  enabled: z.boolean(),
  day_of_month: z.number().int().min(1).max(28),
  recipients_mode: z.enum(['all_members', 'admins', 'extra_only']),
  extra_emails: z.array(z.string().max(254)).max(20),
});

async function resolve(context: RouteContext) {
  const { slug } = await context.params;
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { error: NextResponse.json({ error: 'Authentication required' }, { status: 401, headers: noStore }) };
  const { data: organization } = await supabase.from('organizations').select('id,owner_id').eq('slug', slug).is('deleted_at', null).maybeSingle();
  if (!organization) return { error: NextResponse.json({ error: 'Organization not found' }, { status: 404, headers: noStore }) };
  // Statement settings belong to the space's real owner and admins (a super admin only reads statements, not settings).
  const { data: membership } = await supabase.from('organization_members').select('role')
    .eq('organization_id', organization.id).eq('user_id', user.id).eq('status', 'active').maybeSingle();
  if (membership?.role !== 'admin') return { error: NextResponse.json({ error: 'Only the owner and admins can manage statements.' }, { status: 403, headers: noStore }) };
  return { supabase, organization, isOwner: organization.owner_id === user.id };
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const resolved = await resolve(context);
    if ('error' in resolved) return resolved.error;
    const { data } = await resolved.supabase.from('statement_settings')
      .select('enabled,day_of_month,recipients_mode,extra_emails,last_sent_period,last_sent_at,last_error')
      .eq('organization_id', resolved.organization.id).maybeSingle();
    return NextResponse.json({
      settings: data ?? { enabled: false, day_of_month: 1, recipients_mode: 'admins', extra_emails: [], last_sent_period: null, last_sent_at: null, last_error: null },
      email_configured: emailIsConfigured(),
      is_owner: resolved.isOwner,
    }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500, headers: noStore });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const resolved = await resolve(context);
    if ('error' in resolved) return resolved.error;
    const parsed = settingsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Check the statement settings.' }, { status: 422, headers: noStore });
    const { error } = await resolved.supabase.rpc('save_statement_settings', {
      p_organization_id: resolved.organization.id,
      p_enabled: parsed.data.enabled,
      p_day_of_month: parsed.data.day_of_month,
      p_recipients_mode: parsed.data.recipients_mode,
      p_extra_emails: parsed.data.extra_emails,
    });
    if (error) {
      const missing = error.code === 'PGRST202';
      return NextResponse.json({ error: missing ? 'Statements need the latest database update. Apply the pending migrations.' : error.message },
        { status: missing ? 503 : error.code === '42501' ? 403 : 422, headers: noStore });
    }
    return NextResponse.json({ status: 'saved' }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500, headers: noStore });
  }
}
