'use client';

import { type FormEvent, Suspense, useState } from 'react';
import { ArrowRight, Check, Command, LoaderCircle, LockKeyhole, Mail, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { getSafeInternalPath } from '@/lib/navigation';
import styles from './page.module.css';

type AuthMode = 'sign-in' | 'sign-up' | 'reset';

function LoginFormContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const confirmationError = searchParams.get('error') === 'confirmation_failed';
  const oauthError = searchParams.get('error') === 'oauth_failed';

  async function signInWithGoogle() {
    setBusy(true);
    setMessage('');
    setErrorMessage('');

    try {
      const callbackUrl = new URL('/auth/callback', window.location.origin);
      callbackUrl.searchParams.set('next', getSafeInternalPath(searchParams.get('next')));
      callbackUrl.searchParams.set('flow', 'google');
      const { error } = await createSupabaseBrowserClient().auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: callbackUrl.toString() },
      });
      if (error) throw error;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to sign in with Google. Please try again.');
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    setErrorMessage('');

    try {
      const supabase = createSupabaseBrowserClient();
      if (mode === 'reset') {
        const callbackUrl = new URL('/auth/callback', window.location.origin);
        callbackUrl.searchParams.set('next', '/reset-password');
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: callbackUrl.toString() });
        if (error) throw error;
        setMessage('If an account exists for that email, a password reset link is on its way.');
        return;
      }

      if (mode === 'sign-up') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: name.trim() },
            emailRedirectTo: (() => {
              const callbackUrl = new URL('/auth/callback', window.location.origin);
              callbackUrl.searchParams.set('next', getSafeInternalPath(searchParams.get('next')));
              return callbackUrl.toString();
            })(),
          },
        });
        if (error) throw error;
        if (!data.session) {
          setMessage('Check your email to confirm your account, then sign in.');
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }

      router.replace(getSafeInternalPath(searchParams.get('next')));
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to authenticate. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.visual} aria-label="FairShare introduction">
        <Link className={styles.brand} href="/" aria-label="FairShare home">
          <span className={styles.brandMark}><Command size={19} aria-hidden="true" /></span>
          <span>fairshare<span className={styles.brandDot}>.</span></span>
        </Link>
        <div className={styles.visualContent}>
          <span className={styles.eyebrow}>SHARED SPENDING, SIMPLIFIED</span>
          <h1>Good memories.<br />Clear balances.</h1>
          <p>Bring every shared expense into one calm, transparent space. No awkward maths required.</p>
          <div className={styles.promise}><Check size={16} aria-hidden="true" /><span>Every split adds up. Every member sees their fair share.</span></div>
        </div>
        <span className={styles.visualFoot}>FairShare · Built for the moments you share</span>
      </section>

      <section className={styles.formSide}>
        <div className={styles.formWrap}>
          <Link className={styles.mobileBrand} href="/" aria-label="FairShare home">
            <span className={styles.brandMark}><Command size={19} aria-hidden="true" /></span>
            <span>fairshare<span className={styles.brandDot}>.</span></span>
          </Link>
          <span className={styles.formEyebrow}>{mode === 'sign-in' ? 'WELCOME BACK' : mode === 'sign-up' ? 'YOUR SHARED SPACE STARTS HERE' : 'ACCOUNT RECOVERY'}</span>
          <h2>{mode === 'sign-in' ? 'Sign in to FairShare' : mode === 'sign-up' ? 'Create your account' : 'Reset your password'}</h2>
          <p className={styles.formIntro}>{mode === 'sign-in' ? 'Pick up right where your group left off.' : mode === 'sign-up' ? 'A few details and you’re ready to split fairly.' : 'We’ll send a secure reset link if that email is registered.'}</p>

          {mode === 'reset'
            ? <button className={styles.backToSignIn} type="button" onClick={() => { setMode('sign-in'); setMessage(''); setErrorMessage(''); }}>← Back to sign in</button>
            : <div className={styles.modeSwitch} role="tablist" aria-label="Account action">
              <button type="button" role="tab" aria-selected={mode === 'sign-in'} className={mode === 'sign-in' ? styles.selected : ''} onClick={() => { setMode('sign-in'); setMessage(''); setErrorMessage(''); }}>Sign in</button>
              <button type="button" role="tab" aria-selected={mode === 'sign-up'} className={mode === 'sign-up' ? styles.selected : ''} onClick={() => { setMode('sign-up'); setMessage(''); setErrorMessage(''); }}>Create account</button>
            </div>}

          {mode !== 'reset' && <>
            <button className={styles.oauthButton} type="button" onClick={signInWithGoogle} disabled={busy}>
              {busy ? <LoaderCircle size={18} className={styles.spinner} aria-hidden="true" /> : <svg className={styles.googleMark} viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z" /><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.76 7.18l7.73 6C44.42 38.08 46.98 31.92 46.98 24.55Z" /><path fill="#FBBC05" d="M10.53 28.59a14.4 14.4 0 0 1 0-9.18l-7.98-6.19a23.9 23.9 0 0 0 0 21.56l7.98-6.19Z" /><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6C30.06 37.82 27.25 39 24 39c-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 43.62 14.62 48 24 48Z" /></svg>}
              {busy ? 'Connecting…' : 'Continue with Google'}
            </button>
            <div className={styles.divider}><span>or continue with email</span></div>
          </>}

          <form onSubmit={submit} className={styles.form}>
            {mode === 'sign-up' && (
              <label className={styles.field}>
                <span>Your name</span>
                <span className={styles.inputWrap}><UserRound size={17} aria-hidden="true" /><input autoComplete="name" value={name} onChange={event => setName(event.target.value)} minLength={2} maxLength={100} required placeholder="e.g. Vansh Gupta" /></span>
              </label>
            )}
            <label className={styles.field}>
              <span>Email address</span>
              <span className={styles.inputWrap}><Mail size={17} aria-hidden="true" /><input type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} required placeholder="you@example.com" /></span>
            </label>
            {mode !== 'reset' && <label className={styles.field}>
              <span>Password</span>
              <span className={styles.inputWrap}><LockKeyhole size={17} aria-hidden="true" /><input type="password" autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} value={password} onChange={event => setPassword(event.target.value)} minLength={8} required placeholder="At least 8 characters" /></span>
            </label>}
            {(errorMessage || confirmationError || oauthError) && <p className={styles.error} role="alert">{errorMessage || (oauthError ? 'Google sign-in could not be completed. Please try again.' : 'That confirmation link is invalid or expired. Request a new one and try again.')}</p>}
            {message && <p className={styles.success} role="status">{message}</p>}
            <button className={styles.submit} type="submit" disabled={busy}>
              {busy ? <LoaderCircle size={17} className={styles.spinner} aria-hidden="true" /> : null}
              {busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : mode === 'sign-up' ? 'Create account' : 'Send reset link'}
              {!busy && <ArrowRight size={17} aria-hidden="true" />}
            </button>
          </form>

          {mode === 'sign-in' && <button className={styles.forgotPassword} type="button" onClick={() => { setMode('reset'); setMessage(''); setErrorMessage(''); }}>Forgot your password?</button>}
          <p className={styles.privacy}><LockKeyhole size={13} aria-hidden="true" /> Your groups are private. Access is protected at the database level.</p>
        </div>
        <footer className={styles.footer}><span>© {new Date().getFullYear()} FairShare</span><span>Shared costs, settled fairly.</span></footer>
      </section>
    </main>
  );
}

export default function LoginForm() {
  return <Suspense fallback={<main className={styles.page} aria-busy="true" />}>
    <LoginFormContent />
  </Suspense>;
}
