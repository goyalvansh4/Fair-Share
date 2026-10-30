import InviteAcceptance from './invite-acceptance';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/supabase/auth';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  return <InviteAcceptance token={token} />;
}
