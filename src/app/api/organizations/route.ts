import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).min(2).max(70),
  description: z.string().trim().max(1000).optional(),
  type: z.enum(['trip', 'room', 'party', 'personal', 'custom']).default('custom'),
  currency: z.string().regex(/^[A-Z]{3}$/).default('INR'),
  timezone: z.string().min(1).max(100).default('Asia/Kolkata').refine(value => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
  }, 'Unknown timezone'),
  starts_on: z.iso.date().optional(),
  ends_on: z.iso.date().optional(),
}).refine(v => !v.starts_on || !v.ends_on || v.ends_on >= v.starts_on, { message: 'End date must be on or after start date', path: ['ends_on'] });

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const { data, error } = await supabase.from('organizations')
      .select('id,name,slug,description,type,currency,timezone,starts_on,ends_on,status,created_at,organization_members!inner(role,status)')
      .eq('organization_members.user_id', user.id).eq('organization_members.status', 'active')
      .is('deleted_at', null).order('created_at', { ascending: false });
    if (error) return NextResponse.json({ error: 'Unable to load organizations' }, { status: 400 });
    return NextResponse.json({ organizations: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const parsed = createOrganizationSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid organization details', details: parsed.error.flatten() }, { status: 422 });
    const input = parsed.data;
    // No RETURNING on the insert: the creator's membership is added by an AFTER INSERT trigger,
    // so the SELECT policy cannot see the new row until the statement has finished.
    const id = crypto.randomUUID();
    const { error } = await supabase.from('organizations').insert({
      ...input,
      id,
      created_by: user.id,
      description: input.description || null,
      starts_on: input.starts_on || null,
      ends_on: input.ends_on || null,
    });
    if (error) {
      console.error('organization insert failed', error.code, error.message);
      if (error.code === '23505') return NextResponse.json({ error: 'That organization slug is already taken' }, { status: 409 });
      // Raised by the one-admin-per-space rule; the message tells the person how to proceed.
      if (error.code === '22023') return NextResponse.json({ error: error.message }, { status: 422 });
      return NextResponse.json({ error: 'Unable to create organization' }, { status: 400 });
    }
    const { data, error: readError } = await supabase.from('organizations')
      .select('id,name,slug,type,currency,timezone,starts_on,ends_on,status,created_at')
      .eq('id', id).single();
    if (readError || !data) {
      console.error('organization read-back failed', readError?.code, readError?.message);
      return NextResponse.json({ error: 'Organization was created but could not be loaded. Refresh the page.' }, { status: 500 });
    }
    return NextResponse.json({ organization: data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}
