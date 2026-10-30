import Link from 'next/link';
import { Command, MoveLeft } from 'lucide-react';

export default function NotFound() {
  return (
    <main style={{ display: 'grid', minHeight: '100vh', placeItems: 'center', padding: 24, background: '#f7f8fb' }}>
      <section style={{ width: 'min(100%, 440px)', padding: 32, border: '1px solid #e9ebf1', borderRadius: 16, background: '#fff', textAlign: 'center' }}>
        <span aria-hidden="true" style={{ display: 'inline-grid', width: 42, height: 42, placeItems: 'center', borderRadius: 12, background: '#6d5ce8', color: '#fff' }}><Command size={21} /></span>
        <p style={{ margin: '22px 0 7px', color: '#7668d9', fontSize: 10, fontWeight: 700, letterSpacing: 1.2 }}>404 · SPACE NOT FOUND</p>
        <h1 style={{ margin: 0, color: '#292b40', fontSize: 26, letterSpacing: -0.8 }}>This page isn’t here.</h1>
        <p style={{ color: '#85899a', fontSize: 12, lineHeight: 1.6 }}>The link may be incorrect, or you may no longer have access to this shared space.</p>
        <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 10, padding: '10px 13px', borderRadius: 8, background: '#6d5ce8', color: '#fff', fontSize: 11, fontWeight: 700, textDecoration: 'none' }}><MoveLeft size={15} />Back to FairShare</Link>
      </section>
    </main>
  );
}
