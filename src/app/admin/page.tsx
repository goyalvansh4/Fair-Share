import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import AdminConsole from './admin-console';

export const metadata: Metadata = { title: 'Admin console', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent('/admin')}`);
  // Anyone who is not a platform admin sees an ordinary "not found" page, so the console does not advertise itself.
  const { data: platformAdmin } = await supabase.rpc('is_platform_admin_account');
  if (platformAdmin !== true) notFound();
  return <AdminConsole />;
}
