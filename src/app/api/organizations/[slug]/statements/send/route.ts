import { NextResponse } from 'next/server';
import { z } from 'zod';
import { emailIsConfigured } from '@/lib/statements/mailer';
import { isMonthKey, localMonthAndDay, monthRange, previousMonthKey } from '@/lib/statements/period';
import { resolveRecipients, type RecipientMode } from '@/lib/statements/recipients';
import { emailStatement } from '@/lib/statements/service';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const noStore = { 'Cache-Control': 'no-store' };

// "Send now": emails the chosen month's statement to the configured recipients. Real owner and admins only.
export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401, headers: noStore });
    const parsed = z.object({ month: z.string().optional() }).safeParse(await request.json().catch(() => ({})));
    if (!parsed.success || (parsed.data.month && !isMonthKey(parsed.data.month))) {
      return NextResponse.json({ error: 'Choose a month like 2026-10.' }, { status: 422, headers: noStore });
    }
    const { data: organization } = await supabase
      .from('organizations').select('id,name,slug,currency,timezone').eq('slug', slug).is('deleted_at', null).maybeSingle();
    if (!organization) return NextResponse.json({ error: 'Organization not found' }, { status: 404, headers: noStore });
    const { data: membership } = await supabase.from('organization_members').select('role')
      .eq('organization_id', organization.id).eq('user_id', user.id).eq('status', 'active').maybeSingle();
    if (membership?.role !== 'admin') return NextResponse.json({ error: 'Only the owner and admins can send statements.' }, { status: 403, headers: noStore });
    if (!emailIsConfigured()) return NextResponse.json({ error: 'Email is not set up yet. Ask an admin to add the SMTP settings.' }, { status: 503, headers: noStore });

    const { data: settings } = await supabase.from('statement_settings')
      .select('recipients_mode,extra_emails').eq('organization_id', organization.id).maybeSingle();
    const { data: contacts, error: contactError } = await supabase.rpc('statement_recipient_emails', { p_organization_id: organization.id });
    if (contactError) return NextResponse.json({ error: 'Unable to read the recipients.' }, { status: 400, headers: noStore });
    const recipients = resolveRecipients(
      (settings?.recipients_mode as RecipientMode | undefined) ?? 'admins',
      ((contacts ?? []) as { member_role: string; email: string | null }[]).map(row => ({ role: row.member_role, email: row.email })),
      (settings?.extra_emails as string[] | undefined) ?? [],
    );

    const month = monthRange(parsed.data.month ?? previousMonthKey(localMonthAndDay(new Date(), organization.timezone).key));
    const result = await emailStatement(supabase, organization, month, recipients);
    if (result.sent === 0) {
      return NextResponse.json({ error: `The email could not be sent: ${result.failed[0]?.reason ?? 'unknown error'}` }, { status: 502, headers: noStore });
    }
    return NextResponse.json({ sent: result.sent, failed: result.failed.length, month: month.label }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to send the statement' }, { status: 500, headers: noStore });
  }
}
