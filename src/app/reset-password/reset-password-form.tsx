'use client';

import { type FormEvent, useState } from 'react';
import { ArrowRight, Command, LoaderCircle, LockKeyhole } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import styles from './page.module.css';

export default function ResetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage('');
    if (password !== confirmPassword) {
      setErrorMessage('Those passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      const { error } = await createSupabaseBrowserClient().auth.updateUser({ password });
      if (error) throw error;
      router.replace('/');
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to update your password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <span className={styles.mark}><Command size={20} /></span>
        <span className={styles.eyebrow}>ACCOUNT RECOVERY</span>
        <h1>Choose a new password.</h1>
        <p>Use at least 8 characters. Your new password will replace the old one immediately.</p>
        <form className={styles.form} onSubmit={submit}>
          <label>New password<span><LockKeyhole size={16} /><input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} minLength={8} required /></span></label>
          <label>Confirm new password<span><LockKeyhole size={16} /><input type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} minLength={8} required /></span></label>
          {errorMessage && <p className={styles.error} role="alert">{errorMessage}</p>}
          <button className={styles.action} disabled={busy}>{busy ? <LoaderCircle size={16} className={styles.spinner} /> : null}{busy ? 'Updating…' : 'Update password'}{!busy && <ArrowRight size={16} />}</button>
        </form>
      </section>
    </main>
  );
}
