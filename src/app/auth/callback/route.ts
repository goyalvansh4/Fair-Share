import { NextResponse } from 'next/server';
import { getSafeInternalPath } from '@/lib/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const failurePath = url.searchParams.get('flow') === 'google' ? '/login?error=oauth_failed' : '/login?error=confirmation_failed';
  if (!code) return NextResponse.redirect(new URL(failurePath, url.origin));

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(new URL(failurePath, url.origin));

  return NextResponse.redirect(new URL(getSafeInternalPath(url.searchParams.get('next')), url.origin));
}
