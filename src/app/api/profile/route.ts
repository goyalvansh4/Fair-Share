import { NextResponse } from 'next/server';
import { z } from 'zod';
import { normalizePhone } from '@/lib/profile/phone';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const profileSchema = z.object({
  display_name: z.string().trim().min(2, 'Enter your name (at least 2 characters).').max(100, 'Your name can be up to 100 characters.'),
  phone: z.string().max(40).optional().default(''),
});

// Own profile: name, mobile number and (read-only) email.
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const { data: profile } = await supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle();
    // The contacts table may not exist on databases that have not applied the latest migration.
    const { data: contact } = await supabase.from('profile_contacts').select('phone').eq('user_id', user.id).maybeSingle();
    return NextResponse.json({
      display_name: profile?.display_name ?? '',
      phone: contact?.phone ?? null,
      email: user.email ?? null,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

    const parsed = profileSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Check your details' }, { status: 422 });
    let phone: string | null;
    try {
      phone = normalizePhone(parsed.data.phone);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Enter a valid phone number.' }, { status: 422 });
    }

    const { error: nameError } = await supabase.from('profiles').update({ display_name: parsed.data.display_name }).eq('id', user.id);
    if (nameError) return NextResponse.json({ error: 'Unable to save your name' }, { status: 400 });

    const { error: contactError } = await supabase.from('profile_contacts').upsert({ user_id: user.id, phone }, { onConflict: 'user_id' });
    if (contactError) {
      const missing = contactError.code === '42P01' || contactError.code === 'PGRST205';
      if (missing && phone === null) return NextResponse.json({ display_name: parsed.data.display_name, phone: null });
      return NextResponse.json({
        error: missing ? 'Saving a mobile number needs the latest database update. Ask an admin to apply the pending migrations.' : 'Unable to save your mobile number',
      }, { status: missing ? 503 : 400 });
    }

    // Keep the sign-in profile in step so the name shows up consistently everywhere.
    await supabase.auth.updateUser({ data: { display_name: parsed.data.display_name } }).catch(() => undefined);
    return NextResponse.json({ display_name: parsed.data.display_name, phone });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}
