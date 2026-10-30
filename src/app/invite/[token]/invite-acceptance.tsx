'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Command, LoaderCircle, Users } from 'lucide-react';
import styles from './page.module.css';

export default function InviteAcceptance({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [complete, setComplete] = useState(false);

  async function acceptInvitation() {
    setBusy(true);
    setErrorMessage('');
    try {
      const response = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = typeof result === 'object' && result !== null && 'error' in result
          ? String(result.error)
          : 'Unable to accept this invitation.';
        throw new Error(message);
      }
      if (typeof result !== 'object' || result === null || !('organization_slug' in result) || typeof result.organization_slug !== 'string') {
        throw new Error('The invitation response was incomplete. Please try again.');
      }
      window.localStorage.setItem('fairshare.active-organization', result.organization_slug);
      setComplete(true);
      router.replace('/');
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to accept this invitation.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <span className={styles.mark}><Command size={21} /></span>
        <span className={styles.eyebrow}>YOU’RE INVITED</span>
        <h1>Join a shared space.</h1>
        <p>Accept this invitation to see the group’s expenses, fair splits, and balances. If this invite was sent to a specific email, sign in with that address.</p>
        {errorMessage && <p className={styles.error} role="alert">{errorMessage}</p>}
        {complete && <p className={styles.success} role="status"><Check size={16} />Invitation accepted. Opening your space…</p>}
        <button className={styles.action} onClick={() => void acceptInvitation()} disabled={busy || complete}>
          {busy ? <LoaderCircle size={16} className={styles.spinner} /> : <Users size={16} />}
          {busy ? 'Joining…' : 'Accept invitation'}
        </button>
        <small>Invite links expire after 7 days.</small>
      </section>
    </main>
  );
}
