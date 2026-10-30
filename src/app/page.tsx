import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/supabase/auth';
import WorkspaceClient from './workspace-client';

export default async function HomePage({ searchParams }: { searchParams: Promise<{ code?: string | string[]; admin_space?: string | string[] }> }) {
  // If the auth redirect URL was not allow-listed, Supabase falls back to the Site URL with ?code=...
  // Hand that code to the callback instead of dropping it, so sign-in still completes.
  const { code, admin_space: adminSpaceParam } = await searchParams;
  if (typeof code === 'string' && code) {
    redirect(`/auth/callback?code=${encodeURIComponent(code)}&flow=google`);
  }
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  // Opened from the super-admin console. Only the shape is checked here; the database decides whether access exists.
  const adminSpace = typeof adminSpaceParam === 'string' && adminSpaceParam.length <= 70 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(adminSpaceParam)
    ? adminSpaceParam
    : undefined;
  return <WorkspaceClient adminSpace={adminSpace} />;
}
