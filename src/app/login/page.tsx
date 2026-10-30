import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/supabase/auth';
import LoginForm from './login-form';

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect('/');
  return <LoginForm />;
}
