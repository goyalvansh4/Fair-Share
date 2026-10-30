import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/supabase/auth';
import ResetPasswordForm from './reset-password-form';

export default async function ResetPasswordPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login?next=%2Freset-password');
  return <ResetPasswordForm />;
}
