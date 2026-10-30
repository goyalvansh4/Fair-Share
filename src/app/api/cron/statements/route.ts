import { NextResponse } from 'next/server';
import { emailIsConfigured } from '@/lib/statements/mailer';
import { dueStatementPeriod, monthRange } from '@/lib/statements/period';
import { resolveRecipients, type RecipientMode } from '@/lib/statements/recipients';
import { emailStatement } from '@/lib/statements/service';
import { createSupabaseServiceClient } from '@/lib/supabase/service';

const noStore = { 'Cache-Control': 'no-store' };
const MAX_PER_RUN = 25;

async function sameSecret(attempt: string, expected: string): Promise<boolean> {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(attempt), digest(expected)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

// Called once a day by the scheduled Worker (see worker.mjs). Sends every statement that is due, once per month.
export async function POST(request: Request) {
  try {
    const secret = process.env.CRON_SECRET ?? '';
    if (secret.length < 24) return NextResponse.json({ error: 'Not configured' }, { status: 503, headers: noStore });
    const header = request.headers.get('authorization') ?? '';
    if (!header.startsWith('Bearer ') || !(await sameSecret(header.slice(7), secret))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStore });
    }
    if (!emailIsConfigured()) return NextResponse.json({ error: 'Email is not configured' }, { status: 503, headers: noStore });

    const service = createSupabaseServiceClient();
    const { data: settingsRows, error } = await service.from('statement_settings')
      .select('organization_id,day_of_month,recipients_mode,extra_emails,last_sent_period').eq('enabled', true).limit(500);
    if (error) return NextResponse.json({ error: 'Unable to read settings' }, { status: 500, headers: noStore });

    const now = new Date();
    const results: { organization: string; status: string }[] = [];
    let processed = 0;
    for (const settings of settingsRows ?? []) {
      if (processed >= MAX_PER_RUN) break;
      const { data: organization } = await service.from('organizations')
        .select('id,name,slug,currency,timezone,status,deleted_at').eq('id', settings.organization_id).maybeSingle();
      if (!organization || organization.deleted_at || organization.status !== 'active') continue;
      const period = dueStatementPeriod(
        { enabled: true, dayOfMonth: settings.day_of_month, lastSentPeriod: settings.last_sent_period },
        now, organization.timezone,
      );
      if (!period) continue;

      // Claim the period first so two overlapping runs cannot send the same statement twice.
      const { data: claimed } = await service.from('statement_settings')
        .update({ last_sent_period: period, last_sent_at: now.toISOString(), last_error: null })
        .eq('organization_id', organization.id).or(`last_sent_period.is.null,last_sent_period.neq.${period}`)
        .select('organization_id');
      if (!claimed?.length) continue;
      processed += 1;

      try {
        const { data: contacts } = await service.rpc('statement_recipient_emails', { p_organization_id: organization.id });
        const recipients = resolveRecipients(
          settings.recipients_mode as RecipientMode,
          ((contacts ?? []) as { member_role: string; email: string | null }[]).map(row => ({ role: row.member_role, email: row.email })),
          settings.extra_emails ?? [],
        );
        const outcome = await emailStatement(service, organization, monthRange(period), recipients);
        if (outcome.sent === 0) throw new Error(outcome.failed[0]?.reason ?? 'No email could be sent');
        results.push({ organization: organization.slug, status: `sent ${outcome.sent}` });
      } catch (sendError) {
        // Release the claim so tomorrow's run tries again, and keep the reason where admins can see it.
        await service.from('statement_settings')
          .update({ last_sent_period: settings.last_sent_period, last_error: (sendError instanceof Error ? sendError.message : 'Send failed').slice(0, 300) })
          .eq('organization_id', organization.id);
        results.push({ organization: organization.slug, status: 'failed' });
      }
    }
    return NextResponse.json({ processed, results }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500, headers: noStore });
  }
}
