'use client';

import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Command, Lock, LoaderCircle, LogOut, Pencil, RotateCcw, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { describeActivity, matchesSpaceFilter, type SpaceFilter } from '@/lib/admin/space-health';
import { formatMinorUnits } from '@/lib/money';
import styles from './admin.module.css';

type AdminStatus = { platform_admin: boolean; unlocked: boolean; expires_at: string | null; configured: boolean };
type SpaceRow = {
  id: string; name: string; slug: string; type: string; status: string; currency: string; timezone: string;
  created_at: string; deleted_at: string | null; owner_name: string | null; owner_email: string | null;
  member_count: number; expense_count: number; total_spend_minor: number; last_activity_at: string;
};

const filterLabels: Record<SpaceFilter, string> = { all: 'All', inactive: 'Inactive 30+ days', empty: 'Empty', paused: 'Archived or paused' };
const typeLabels: Record<string, string> = { trip: 'Trip', room: 'Shared home', party: 'Event', personal: 'Personal', custom: 'Other' };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(typeof payload === 'object' && payload !== null && 'error' in payload ? String((payload as { error: unknown }).error) : 'Request failed');
  }
  return payload as T;
}

function minutesLeft(expiresAt: string | null): number {
  return expiresAt ? Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 60000)) : 0;
}

export default function AdminConsole() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [spaces, setSpaces] = useState<SpaceRow[]>([]);
  const [view, setView] = useState<'live' | 'deleted'>('live');
  const [filter, setFilter] = useState<SpaceFilter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<SpaceRow | null>(null);
  const [editForm, setEditForm] = useState({ name: '', type: 'custom', timezone: '', status: 'active' });
  const [showDelete, setShowDelete] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<AdminStatus>('/api/admin/status'));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to check the console.');
    }
  }, []);

  // Check access and load spaces; repeat every 30 seconds so an expired unlock closes the console instead of leaving stale data.
  useEffect(() => {
    let active = true;
    async function check() {
      try {
        const next = await api<AdminStatus>('/api/admin/status');
        if (!active) return;
        setStatus(next);
        setNow(new Date());
        if (next.unlocked) {
          const { organizations } = await api<{ organizations: SpaceRow[] }>(`/api/admin/organizations${view === 'deleted' ? '?deleted=1' : ''}`);
          if (active) setSpaces(organizations);
        } else {
          setSpaces([]);
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to check the console.');
      }
    }
    void check();
    const timer = window.setInterval(() => { void check(); }, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, [reloadKey, view]);

  const shown = useMemo(() => {
    const text = query.trim().toLowerCase();
    return spaces.filter(space => {
      if (view === 'live' && !matchesSpaceFilter(space, filter, now)) return false;
      return !text || `${space.name} ${space.slug} ${space.owner_name ?? ''} ${space.owner_email ?? ''}`.toLowerCase().includes(text);
    });
  }, [spaces, filter, query, view, now]);

  const counts = useMemo(() => ({
    all: spaces.length,
    inactive: spaces.filter(space => matchesSpaceFilter(space, 'inactive', now)).length,
    empty: spaces.filter(space => matchesSpaceFilter(space, 'empty', now)).length,
    paused: spaces.filter(space => matchesSpaceFilter(space, 'paused', now)).length,
  }), [spaces, now]);

  const selectedIds = [...selected].filter(id => shown.some(space => space.id === id));
  const allShownSelected = shown.length > 0 && selectedIds.length === shown.length;

  function toggle(id: string) {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api<{ unlocked: boolean }>('/api/admin/unlock', { method: 'POST', body: JSON.stringify({ password }) });
      setPassword('');
      await refresh();
      setReloadKey(value => value + 1);
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : 'Unable to unlock.');
    } finally {
      setBusy(false);
    }
  }

  async function lock() {
    setBusy(true);
    try {
      await api<{ unlocked: boolean }>('/api/admin/unlock', { method: 'DELETE' });
      setSpaces([]);
      await refresh();
    } catch (lockError) {
      setError(lockError instanceof Error ? lockError.message : 'Unable to lock.');
    } finally {
      setBusy(false);
    }
  }

  function openEdit(space: SpaceRow) {
    setError('');
    setEditing(space);
    setEditForm({ name: space.name, type: space.type, timezone: space.timezone, status: space.status });
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      await api<{ status: string }>(`/api/admin/organizations/${editing.id}`, { method: 'PATCH', body: JSON.stringify(editForm) });
      setEditing(null);
      setNotice('Space updated.');
      setReloadKey(value => value + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    setBusy(true);
    setError('');
    try {
      const { deleted } = await api<{ deleted: number }>('/api/admin/organizations/delete', {
        method: 'POST',
        body: JSON.stringify({ ids: selectedIds, reason: deleteReason.trim() || undefined }),
      });
      setShowDelete(false);
      setDeleteText('');
      setDeleteReason('');
      setSelected(new Set());
      setNotice(`${deleted} ${deleted === 1 ? 'space' : 'spaces'} deleted. You can restore them from the Deleted view.`);
      setReloadKey(value => value + 1);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete.');
    } finally {
      setBusy(false);
    }
  }

  async function restoreSelected() {
    setBusy(true);
    setError('');
    try {
      const { restored } = await api<{ restored: number }>('/api/admin/organizations/restore', { method: 'POST', body: JSON.stringify({ ids: selectedIds }) });
      setSelected(new Set());
      setNotice(`${restored} ${restored === 1 ? 'space' : 'spaces'} restored.`);
      setReloadKey(value => value + 1);
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : 'Unable to restore.');
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return <main className={styles.center}><LoaderCircle size={22} className={styles.spinner} />Checking access…</main>;
  }

  if (!status.unlocked) {
    return (
      <main className={styles.center}>
        <form className={styles.card} onSubmit={unlock}>
          <span className={styles.mark}><Lock size={20} /></span>
          <span className={styles.eyebrow}>SUPER ADMIN</span>
          <h1>Admin console</h1>
          <p>Enter the console password to manage spaces. Access closes automatically after a short time.</p>
          {!status.configured && <p className={styles.error} role="alert">The console password is not configured on the server (ADMIN_CONSOLE_PASSWORD, at least 12 characters).</p>}
          <label>Console password
            <input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required disabled={busy || !status.configured} autoFocus />
          </label>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button className={styles.primary} type="submit" disabled={busy || !status.configured || !password}>{busy ? 'Checking…' : 'Unlock'}</button>
          <Link className={styles.back} href="/">← Back to FairShare</Link>
        </form>
      </main>
    );
  }

  const left = minutesLeft(status.expires_at);
  const confirmedDelete = deleteText.trim().toUpperCase() === 'DELETE';
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <span className={styles.brand}><span className={styles.mark}><Command size={18} /></span>fairshare<span className={styles.dot}>.</span> <em>admin</em></span>
        <div className={styles.headerActions}>
          <span className={styles.pill}><ShieldCheck size={14} />Unlocked · {left} min left</span>
          <button className={styles.secondary} onClick={() => void lock()} disabled={busy}><LogOut size={15} />Lock now</button>
        </div>
      </header>
      <section className={styles.content}>
        <div className={styles.titleRow}>
          <div><span className={styles.eyebrow}>{view === 'deleted' ? 'DELETED SPACES' : 'ALL SPACES'}</span><h1>{spaces.length} {spaces.length === 1 ? 'space' : 'spaces'}</h1></div>
          <label className={styles.search}><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search name, owner or email" aria-label="Search spaces" /></label>
        </div>

        <div className={styles.chips} role="group" aria-label="Filter spaces">
          <button className={`${styles.chip} ${view === 'live' && filter === 'all' ? styles.chipActive : ''}`} onClick={() => { setView('live'); setFilter('all'); setSelected(new Set()); }}>All ({view === 'live' ? counts.all : '…'})</button>
          {(['inactive', 'empty', 'paused'] as const).map(key => (
            <button key={key} className={`${styles.chip} ${view === 'live' && filter === key ? styles.chipActive : ''}`} onClick={() => { setView('live'); setFilter(key); setSelected(new Set()); }}>{filterLabels[key]}{view === 'live' ? ` (${counts[key]})` : ''}</button>
          ))}
          <button className={`${styles.chip} ${view === 'deleted' ? styles.chipActive : ''}`} onClick={() => { setView('deleted'); setSelected(new Set()); }}>Deleted</button>
        </div>

        {notice && <p className={styles.notice} role="status">{notice}</p>}
        {error && !editing && !showDelete && <p className={styles.error} role="alert">{error}</p>}

        {shown.length > 0 && <div className={styles.bulkBar}>
          <label className={styles.checkAll}><input type="checkbox" checked={allShownSelected} onChange={() => setSelected(allShownSelected ? new Set() : new Set(shown.map(space => space.id)))} />{selectedIds.length ? `${selectedIds.length} selected` : 'Select all'}</label>
          {selectedIds.length > 0 && (view === 'live'
            ? <button className={styles.danger} disabled={busy} onClick={() => { setError(''); setDeleteText(''); setShowDelete(true); }}><Trash2 size={15} />Delete {selectedIds.length}</button>
            : <button className={styles.secondary} disabled={busy} onClick={() => void restoreSelected()}><RotateCcw size={15} />Restore {selectedIds.length}</button>)}
        </div>}

        <ul className={styles.list}>
          {shown.map(space => (
            <li key={space.id} className={`${styles.row} ${selected.has(space.id) ? styles.rowSelected : ''}`}>
              <input className={styles.rowCheck} type="checkbox" checked={selected.has(space.id)} onChange={() => toggle(space.id)} aria-label={`Select ${space.name}`} />
              <div className={styles.rowMain}>
                <strong>{space.name}{space.status !== 'active' && <span className={styles.badge}>{space.status}</span>}</strong>
                <span>/{space.slug} · {typeLabels[space.type] ?? space.type} · owner {space.owner_name || 'unknown'}{space.owner_email ? ` (${space.owner_email})` : ''}</span>
                <span>{space.member_count} {space.member_count === 1 ? 'person' : 'people'} · {space.expense_count} {space.expense_count === 1 ? 'expense' : 'expenses'} · {formatMinorUnits(Number(space.total_spend_minor), space.currency)} · {space.deleted_at ? `Deleted ${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(space.deleted_at))}` : describeActivity(space.last_activity_at, now)}</span>
              </div>
              <div className={styles.rowActions}>
                {!space.deleted_at && <button className={styles.secondary} onClick={() => openEdit(space)}><Pencil size={14} />Edit</button>}
                {!space.deleted_at && <Link className={styles.open} href={`/?admin_space=${encodeURIComponent(space.slug)}`}>Open <ArrowUpRight size={15} /></Link>}
              </div>
            </li>
          ))}
          {!shown.length && <li className={styles.empty}>{view === 'deleted' ? 'No deleted spaces.' : 'No spaces match.'}</li>}
        </ul>
      </section>

      {editing && (
        <div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget) setEditing(null); }}>
          <form className={styles.dialog} onSubmit={saveEdit} role="dialog" aria-modal="true" aria-labelledby="edit-title">
            <div className={styles.dialogHead}><h2 id="edit-title">Edit space</h2><button type="button" className={styles.iconButton} aria-label="Close" onClick={() => setEditing(null)}><X size={18} /></button></div>
            <p className={styles.muted}>/{editing.slug} · {editing.currency}. The link name and currency cannot be changed.</p>
            <label>Name<input value={editForm.name} onChange={event => setEditForm(current => ({ ...current, name: event.target.value }))} minLength={2} maxLength={80} required /></label>
            <label>Type<select value={editForm.type} onChange={event => setEditForm(current => ({ ...current, type: event.target.value }))}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Status<select value={editForm.status} onChange={event => setEditForm(current => ({ ...current, status: event.target.value }))}><option value="active">Active</option><option value="archived">Archived</option><option value="suspended">Suspended</option></select></label>
            <label>Timezone<input value={editForm.timezone} onChange={event => setEditForm(current => ({ ...current, timezone: event.target.value }))} required placeholder="Asia/Kolkata" /></label>
            {error && <p className={styles.error} role="alert">{error}</p>}
            <div className={styles.dialogActions}><button type="button" className={styles.secondary} onClick={() => setEditing(null)}>Cancel</button><button className={styles.primaryInline} type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
          </form>
        </div>
      )}

      {showDelete && (
        <div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget) setShowDelete(false); }}>
          <form className={styles.dialog} onSubmit={event => { event.preventDefault(); if (confirmedDelete) void deleteSelected(); }} role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <div className={styles.dialogHead}><h2 id="delete-title">Delete {selectedIds.length} {selectedIds.length === 1 ? 'space' : 'spaces'}?</h2><button type="button" className={styles.iconButton} aria-label="Close" onClick={() => setShowDelete(false)}><X size={18} /></button></div>
            <p className={styles.muted}>Members lose access and joining codes stop working. Expenses and payments are kept, and you can restore a space from the Deleted view.</p>
            <label>Reason (optional, kept in the audit log)<input value={deleteReason} onChange={event => setDeleteReason(event.target.value)} maxLength={300} placeholder="e.g. unused test space" /></label>
            <label>Type DELETE to confirm<input value={deleteText} onChange={event => setDeleteText(event.target.value)} autoComplete="off" placeholder="DELETE" /></label>
            {error && <p className={styles.error} role="alert">{error}</p>}
            <div className={styles.dialogActions}><button type="button" className={styles.secondary} onClick={() => setShowDelete(false)}>Cancel</button><button className={styles.dangerSolid} type="submit" disabled={busy || !confirmedDelete}>{busy ? 'Deleting…' : 'Delete'}</button></div>
          </form>
        </div>
      )}
    </main>
  );
}
