'use client';

import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownLeft, ArrowUpRight, Camera, Check, ChevronDown, Command, Copy, CreditCard,
  LayoutDashboard, LoaderCircle, LogOut, Pencil, Plus, ReceiptText, Search,
  Eye, EyeOff, ShieldCheck, Trash2, UserMinus, Users, Wallet, X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  applySettlementAdjustments, type Balance, calculateBalances, splitByWeights, splitEqually, suggestSettlements,
} from '@/lib/expenses/engine';
import {
  daysAgo, filterExpenses, inferSplitMode, startOfMonth, sumExpenses, toDateInput,
} from '@/lib/expenses/filters';
import { eligibleGroupMemberIds } from '@/lib/expenses/group';
import { parsePreferences, preferencesKey, resolvePreferences } from '@/lib/expenses/preferences';
import { refreshSpace, useWorkspaceStore } from '@/lib/store/workspace-store';
import { type Expense, type Member, type MemberRole, type Settlement } from '@/lib/store/workspace-types';
import { monthRange, recentMonthKeys } from '@/lib/statements/period';
import { formatInviteCode, formatSecretCode, isValidInviteCode, isValidSecretCode, normalizeInviteCode } from '@/lib/invitations/code';
import { formatPhone } from '@/lib/profile/phone';
import { prepareReceiptImage } from '@/lib/receipts/compress-image';
import { type DuplicateKind, type EntrySuggestion, markDuplicates, type ReceiptSuggestion } from '@/lib/receipts/suggestion';
import { formatMinorUnits, getCurrencyFractionDigits, parseMinorUnits } from '@/lib/money';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import styles from './workspace.module.css';

type Organization = {
  id: string;
  name: string;
  slug: string;
  type: string;
  currency: string;
  timezone?: string;
  created_at: string;
  organization_members?: { role: string; status: string }[];
  /** Opened through the super-admin console by someone who is not a member. */
  via_admin?: boolean;
};

type WorkspaceView = 'overview' | 'expenses' | 'balances' | 'members';
type StatementSettings = {
  enabled: boolean; day_of_month: number; recipients_mode: 'all_members' | 'admins' | 'extra_only';
  extra_emails: string[]; last_sent_period: string | null; last_error: string | null;
};
type BulkRow = {
  key: string; include: boolean; title: string; description: string; amount: string; date: string; category: string;
  payerId: string; duplicate: DuplicateKind; direction: 'paid' | 'received' | 'unknown'; confidence: 'high' | 'medium' | 'low'; problem: string;
};
type ApiError = { error?: string };
type ProfileResponse = { display_name: string; phone: string | null; email: string | null };
type SplitMode = 'equal' | 'shares' | 'exact';

const splitModeLabels: Record<SplitMode, string> = {
  equal: 'Equally',
  shares: 'By shares',
  exact: 'Exact amounts',
};

const roleLabels: Record<MemberRole, string> = {
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

const categoryLabels: Record<string, string> = {
  food: 'Food & drinks',
  rent: 'Rent',
  groceries: 'Groceries',
  transport: 'Transport',
  accommodation: 'Stay',
  utilities: 'Utilities',
  shopping: 'Shopping',
  entertainment: 'Entertainment',
  medical: 'Medical',
  travel: 'Travel',
  miscellaneous: 'Other',
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'error' in payload
      ? String((payload as ApiError).error ?? 'Request failed')
      : 'Request failed';
    throw new Error(message);
  }
  return payload as T;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join('') || 'FS';
}

function today(): string {
  return toDateInput(new Date());
}

function formatDate(value: string, withYear = true): string {
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: withYear ? 'numeric' : undefined })
    .format(new Date(value.length === 10 ? `${value}T00:00:00` : value));
}

function amountToInput(amountMinor: number, currency: string): string {
  const digits = getCurrencyFractionDigits(currency);
  return (amountMinor / 10 ** digits).toFixed(digits);
}

export default function WorkspaceClient({ adminSpace }: { adminSpace?: string }) {
  const router = useRouter();
  const [userId, setUserId] = useState('');
  const [userName, setUserName] = useState('FairShare member');
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [activeSlug, setActiveSlug] = useState('');
  const allMembers = useWorkspaceStore(state => state.members);
  const setAllMembers = useWorkspaceStore(state => state.setMembers);
  const expenses = useWorkspaceStore(state => state.expenses);
  const setExpenses = useWorkspaceStore(state => state.setExpenses);
  const settlementRecords = useWorkspaceStore(state => state.settlements);
  const setSettlementRecords = useWorkspaceStore(state => state.setSettlements);
  const [view, setView] = useState<WorkspaceView>('overview');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [rangePreset, setRangePreset] = useState<'all' | 'month' | 'last30' | 'custom'>('all');
  const [initialLoading, setInitialLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [toast, setToast] = useState<{ message: string; tone: 'ok' | 'error' } | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<{ title: string; message: string; confirmLabel: string; danger: boolean } | null>(null);
  const confirmResolver = useRef<((accepted: boolean) => void) | null>(null);
  const [showOrgMenu, setShowOrgMenu] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [showOrgForm, setShowOrgForm] = useState(false);
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [bulkConfirmText, setBulkConfirmText] = useState('');
  const [bulkIncludePayments, setBulkIncludePayments] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'viewer'>('member');
  const [invitationLink, setInvitationLink] = useState('');
  const [invitationEmail, setInvitationEmail] = useState('');
  const [invitationOpen, setInvitationOpen] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [orgType, setOrgType] = useState('trip');
  const [form, setForm] = useState({ title: '', amount: '', expense_date: today(), payer_id: '', category: 'food' });
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [splitMode, setSplitMode] = useState<SplitMode>('equal');
  const [splitScope, setSplitScope] = useState<'group' | 'selected'>('group');
  const [customShareFor, setCustomShareFor] = useState('');
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [profileForm, setProfileForm] = useState({ name: '', phone: '' });
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  // undefined = still loading, null = turned off (or, for the secret, not visible to this person)
  const [inviteCode, setInviteCode] = useState<string | null | undefined>(undefined);
  const [secretCode, setSecretCode] = useState<string | null | undefined>(undefined);
  const [showSecret, setShowSecret] = useState(false);
  const [customSecret, setCustomSecret] = useState('');
  const [joinSecret, setJoinSecret] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [statementMonth, setStatementMonth] = useState('');
  const [statementSettings, setStatementSettings] = useState<StatementSettings | null>(null);
  const [statementMeta, setStatementMeta] = useState({ emailConfigured: true, isOwner: false });
  const [extraEmailsText, setExtraEmailsText] = useState('');
  const [statementBusy, setStatementBusy] = useState(false);
  const [statementNote, setStatementNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [showBulk, setShowBulk] = useState(false);
  const [bulkRows, setBulkRows] = useState<BulkRow[]>([]);
  const [bulkScanning, setBulkScanning] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkNote, setBulkNote] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [splitValues, setSplitValues] = useState<Record<string, string>>({});

  const activeOrganization = organizations.find(organization => organization.slug === activeSlug) ?? null;
  const selectedOrganizationSlug = activeOrganization?.slug;
  const currency = activeOrganization?.currency ?? 'INR';
  const members = useMemo(() => allMembers.filter(member => member.status === 'active'), [allMembers]);

  // Former members stay in the ledger so old expenses keep reconciling, but are labelled as such.
  function memberLabel(id: string): string {
    const member = allMembers.find(item => item.user_id === id);
    if (!member) return 'Former member';
    const name = member.profile.display_name.trim();
    if (member.status === 'removed') return name ? `${name} (left)` : 'Former member';
    return name || 'FairShare member';
  }

  const filteredExpenses = useMemo(() => filterExpenses(expenses, {
    query: search,
    from: dateFrom,
    to: dateTo,
    extraText: expense => allMembers.find(member => member.user_id === expense.payer_id)?.profile.display_name ?? '',
  }), [expenses, allMembers, search, dateFrom, dateTo]);
  const rangeExpenses = useMemo(
    () => filterExpenses(expenses, { query: '', from: dateFrom, to: dateTo }),
    [expenses, dateFrom, dateTo],
  );

  const ledger = useMemo<{ balances: Balance[]; error: string }>(() => {
    if (!allMembers.length) return { balances: [], error: '' };
    try {
      const expenseBalances = calculateBalances(
        allMembers.map(member => member.user_id),
        expenses.map(expense => ({
          payerId: expense.payer_id,
          totalMinor: expense.amount_minor,
          splits: expense.expense_splits.map(split => ({ memberId: split.member_id, amountMinor: split.amount_minor })),
        })),
      );
      return {
        balances: applySettlementAdjustments(expenseBalances, settlementRecords.map(settlement => ({
          fromMemberId: settlement.from_member_id,
          toMemberId: settlement.to_member_id,
          amountMinor: settlement.amount_minor,
          status: settlement.status,
        }))),
        error: '',
      };
    } catch (error) {
      return { balances: [], error: error instanceof Error ? error.message : 'Balances could not be calculated.' };
    }
  }, [expenses, allMembers, settlementRecords]);
  const balances = ledger.balances;
  const visibleBalances = useMemo(() => balances
    .filter(balance => balance.netMinor !== 0 || allMembers.find(member => member.user_id === balance.memberId)?.status === 'active')
    .sort((a, b) => b.netMinor - a.netMinor), [balances, allMembers]);
  const currentBalance = balances.find(balance => balance.memberId === userId);
  const totalSpent = sumExpenses(expenses);
  const leftToSettle = balances.reduce((sum, balance) => sum + Math.max(balance.netMinor, 0), 0);
  const suggestedTransfers = useMemo(() => {
    try {
      return suggestSettlements(balances);
    } catch {
      return [];
    }
  }, [balances]);
  const currentRole = members.find(member => member.user_id === userId)?.role;
  // A super admin opening a space from the admin console acts as its administrator (the database enforces this too).
  const viaAdmin = Boolean(activeOrganization?.via_admin);
  const isOrganizationAdmin = currentRole === 'admin' || viaAdmin;
  const canWrite = currentRole === 'admin' || currentRole === 'member' || viaAdmin;
  // One person can be admin of only one space: they must hand it over before creating another.
  const managesASpace = organizations.some(organization => organization.organization_members?.some(item => item.role === 'admin' && item.status === 'active'));
  const isOwner = members.find(member => member.user_id === userId)?.is_owner === true;
  const canChangeAdmins = isOwner || viaAdmin;
  const closedSettlements = settlementRecords.filter(settlement => settlement.status !== 'pending');
  const canChangeExpense = (expense: Expense) => isOrganizationAdmin || (canWrite && expense.created_by === userId);

  useEffect(() => {
    let active = true;
    async function loadWorkspace() {
      try {
        const supabase = createSupabaseBrowserClient();
        const [{ data: { user }, error: userError }, orgResponse, profileResponse] = await Promise.all([
          supabase.auth.getUser(),
          requestJson<{ organizations: Organization[] }>('/api/organizations'),
          requestJson<ProfileResponse>('/api/profile').catch(() => null),
        ]);
        if (userError) throw userError;
        if (!user) throw new Error('Your session expired. Please sign in again.');
        if (!active) return;
        const metadataName = [user.user_metadata.display_name, user.user_metadata.full_name, user.user_metadata.name]
          .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
        const name = metadataName?.trim() ?? '';
        setUserId(user.id);
        setUserName(profileResponse?.display_name.trim() || name || user.email?.split('@')[0] || 'FairShare member');
        setProfile(profileResponse);
        setOrganizations(orgResponse.organizations);
        // Super admin: add the space opened from /admin to the list, even though the person is not a member of it.
        if (adminSpace && !orgResponse.organizations.some(organization => organization.slug === adminSpace)) {
          try {
            const { organization } = await requestJson<{ organization: Organization }>(`/api/admin/organizations?slug=${encodeURIComponent(adminSpace)}`);
            orgResponse.organizations.push({ ...organization, via_admin: true });
          } catch {
            setErrorMessage('Admin access to that space has expired or is not available. Unlock the admin console again.');
          }
        }
        requestJson<{ platform_admin: boolean }>('/api/admin/status').then(status => { if (active) setPlatformAdmin(status.platform_admin); }).catch(() => undefined);
        let storedSlug: string | null = null;
        try { storedSlug = window.localStorage.getItem('fairshare.active-organization'); } catch { /* storage unavailable */ }
        const chosen = orgResponse.organizations.find(organization => organization.slug === (adminSpace ?? storedSlug))
          ?? orgResponse.organizations[0];
        setActiveSlug(chosen?.slug ?? '');
      } catch (error) {
        if (active) setErrorMessage(error instanceof Error ? error.message : 'Unable to load your workspace.');
      } finally {
        if (active) setInitialLoading(false);
      }
    }
    void loadWorkspace();
    return () => { active = false; };
  }, [adminSpace]);

  useEffect(() => {
    if (!selectedOrganizationSlug) return;
    let active = true;
    async function loadOrganization(slug: string) {
      setDataLoading(true);
      setErrorMessage('');
      try {
        const [memberResponse, expenseResponse, settlementResponse] = await Promise.all([
          requestJson<{ members: Member[] }>(`/api/organizations/${encodeURIComponent(slug)}/members`),
          requestJson<{ expenses: Expense[] }>(`/api/organizations/${encodeURIComponent(slug)}/expenses`),
          requestJson<{ settlements: Settlement[] }>(`/api/organizations/${encodeURIComponent(slug)}/settlements`),
        ]);
        if (!active) return;
        setAllMembers(memberResponse.members);
        setExpenses(expenseResponse.expenses);
        setSettlementRecords(settlementResponse.settlements);
        // Restore the last choices made in this space, limited to people who are still active.
        const activeIds = memberResponse.members.filter(member => member.status === 'active').map(member => member.user_id);
        let stored = null;
        try { stored = parsePreferences(window.localStorage.getItem(preferencesKey(slug))); } catch { /* storage unavailable */ }
        const resolved = resolvePreferences(stored, activeIds, userId, Object.keys(categoryLabels));
        setParticipantIds(resolved.participantIds);
        setSplitMode(resolved.splitMode === 'exact' ? 'equal' : resolved.splitMode);
        setForm(current => ({ ...current, payer_id: resolved.payerId, category: resolved.category }));
      } catch (error) {
        if (active) setErrorMessage(error instanceof Error ? error.message : 'Unable to load this organization.');
      } finally {
        if (active) setDataLoading(false);
      }
    }
    void loadOrganization(selectedOrganizationSlug);
    return () => { active = false; };
  }, [selectedOrganizationSlug, userId, setAllMembers, setExpenses, setSettlementRecords]);

  const activeOrganizationId = activeOrganization?.id;

  // Statement settings are for the space's real owner and admins and load when the Balances tab opens.
  useEffect(() => {
    const slug = selectedOrganizationSlug;
    if (view !== 'balances' || !slug || currentRole !== 'admin') return;
    let active = true;
    async function loadStatementSettings() {
      try {
        const result = await requestJson<{ settings: StatementSettings; email_configured: boolean; is_owner: boolean }>(`/api/organizations/${encodeURIComponent(slug as string)}/statements/settings`);
        if (!active) return;
        setStatementSettings(result.settings);
        setExtraEmailsText(result.settings.extra_emails.join(', '));
        setStatementMeta({ emailConfigured: result.email_configured, isOwner: result.is_owner });
      } catch {
        if (active) setStatementSettings(null);
      }
    }
    void loadStatementSettings();
    return () => { active = false; };
  }, [view, selectedOrganizationSlug, currentRole]);

  useEffect(() => {
    const slug = selectedOrganizationSlug;
    if ((view !== 'members' && !showProfile) || !slug || !(currentRole || viaAdmin)) return;
    let active = true;
    async function loadCodes() {
      try {
        const details = await requestJson<{ code: string | null; secret: string | null }>(`/api/organizations/${encodeURIComponent(slug as string)}/invite-code`);
        if (active) { setInviteCode(details.code); setSecretCode(details.secret); }
      } catch {
        if (active) { setInviteCode(null); setSecretCode(null); }
      }
    }
    void loadCodes();
    return () => { active = false; setInviteCode(undefined); setSecretCode(undefined); };
  }, [view, selectedOrganizationSlug, showProfile, currentRole, viaAdmin]);

  // Live updates: other members' changes arrive through Supabase Realtime. Polling and focus/online refreshes
  // are safety nets for when realtime is not enabled yet or a message is missed.
  useEffect(() => {
    const slug = selectedOrganizationSlug;
    if (!activeOrganizationId || !slug) return;
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'hidden') return;
        void refreshSpace(slug).catch(() => undefined);
      }, 400);
    };
    const supabase = createSupabaseBrowserClient();
    const channel = supabase.channel(`space-${activeOrganizationId}`);
    for (const table of ['expenses', 'expense_splits', 'settlements', 'organization_members']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `organization_id=eq.${activeOrganizationId}` }, refresh);
    }
    channel.subscribe();
    const poll = window.setInterval(refresh, 30000);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', refresh);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', refresh);
      void supabase.removeChannel(channel);
    };
  }, [activeOrganizationId, selectedOrganizationSlug]);

  /** In-page replacement for window.confirm: resolves true when the person confirms, false on cancel, Escape or outside click. */
  function askConfirm(request: { title: string; message: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
    confirmResolver.current?.(false);
    return new Promise(resolve => {
      confirmResolver.current = resolve;
      setConfirmRequest({ danger: false, ...request });
    });
  }

  function answerConfirm(accepted: boolean) {
    const resolve = confirmResolver.current;
    confirmResolver.current = null;
    setConfirmRequest(null);
    resolve?.(accepted);
  }

  useEffect(() => {
    if (!confirmRequest) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const resolve = confirmResolver.current;
      confirmResolver.current = null;
      setConfirmRequest(null);
      resolve?.(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmRequest]);

  function notify(message: string, tone: 'ok' | 'error' = 'ok') {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), tone === 'error' ? 6000 : 3500);
  }

  function fail(error: unknown, fallback: string) {
    const message = describeError(error, fallback);
    setErrorMessage(message);
    notify(message, 'error');
  }

  function describeError(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
  }

  async function reloadSettlements(slug: string) {
    const response = await requestJson<{ settlements: Settlement[] }>(
      `/api/organizations/${encodeURIComponent(slug)}/settlements`,
    );
    setSettlementRecords(response.settlements);
  }

  async function reloadExpenses(slug: string) {
    const response = await requestJson<{ expenses: Expense[] }>(
      `/api/organizations/${encodeURIComponent(slug)}/expenses`,
    );
    setExpenses(response.expenses);
  }

  async function reloadMembers(slug: string) {
    const response = await requestJson<{ members: Member[] }>(
      `/api/organizations/${encodeURIComponent(slug)}/members`,
    );
    setAllMembers(response.members);
  }

  async function recordTransfer(toMemberId: string, amountMinor: number) {
    const slug = activeOrganization?.slug;
    if (!slug || !userId) return;
    setBusy(true);
    setErrorMessage('');
    try {
      await requestJson<{ settlement_id: string }>(`/api/organizations/${encodeURIComponent(slug)}/settlements`, {
        method: 'POST',
        body: JSON.stringify({ from_member_id: userId, to_member_id: toMemberId, amount_minor: amountMinor }),
      });
      await reloadSettlements(slug);
      notify('Transfer recorded. The recipient can confirm when it arrives.');
    } catch (error) {
      setErrorMessage(describeError(error, 'Unable to record the transfer.'));
    } finally {
      setBusy(false);
    }
  }

  async function resolveTransfer(settlement: Settlement, action: 'confirm' | 'cancel') {
    const slug = activeOrganization?.slug;
    if (!slug) return;
    setBusy(true);
    setErrorMessage('');
    try {
      await requestJson<{ status: string }>(
        `/api/organizations/${encodeURIComponent(slug)}/settlements/${encodeURIComponent(settlement.id)}`,
        { method: 'PATCH', body: JSON.stringify({ action }) },
      );
      await reloadSettlements(slug);
      notify(action === 'confirm' ? 'Payment confirmed. Balances are up to date.' : 'Pending transfer cancelled.');
    } catch (error) {
      setErrorMessage(describeError(error, 'Unable to update the transfer.'));
    } finally {
      setBusy(false);
    }
  }

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const slug = activeOrganization?.slug;
    if (!slug) return;
    setInviteBusy(true);
    setErrorMessage('');
    setInvitationLink('');
    try {
      const { invitation } = await requestJson<{ invitation: { token: string; expires_in_days: number } }>(
        `/api/organizations/${encodeURIComponent(slug)}/invitations`,
        { method: 'POST', body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }) },
      );
      setInvitationLink(`${window.location.origin}/invite/${invitation.token}`);
      setInvitationEmail(inviteEmail.trim());
      setInvitationOpen(false);
      setInviteEmail('');
      notify(`Invite link created. It expires in ${invitation.expires_in_days} days.`);
    } catch (error) {
      setErrorMessage(describeError(error, 'Unable to create the invitation.'));
    } finally {
      setInviteBusy(false);
    }
  }

  async function createInviteLink() {
    const slug = activeOrganization?.slug;
    if (!slug) return;
    setInviteBusy(true);
    setErrorMessage('');
    setInvitationLink('');
    try {
      const { invitation } = await requestJson<{ invitation: { token: string; expires_in_days: number } }>(
        `/api/organizations/${encodeURIComponent(slug)}/invitations`,
        { method: 'POST', body: JSON.stringify({ role: inviteRole }) },
      );
      setInvitationLink(`${window.location.origin}/invite/${invitation.token}`);
      setInvitationEmail('');
      setInvitationOpen(true);
      notify(`Invite link created. It expires in ${invitation.expires_in_days} days.`);
    } catch (error) {
      setErrorMessage(describeError(error, 'Unable to create the invite link.'));
    } finally {
      setInviteBusy(false);
    }
  }

  function shareText() {
    return `Join “${activeOrganization?.name ?? 'our group'}” on FairShare to split expenses fairly:`;
  }

  function shareOn(target: 'whatsapp' | 'telegram' | 'x' | 'email') {
    const text = shareText();
    const urls = {
      whatsapp: `https://wa.me/?text=${encodeURIComponent(`${text} ${invitationLink}`)}`,
      telegram: `https://t.me/share/url?url=${encodeURIComponent(invitationLink)}&text=${encodeURIComponent(text)}`,
      x: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(invitationLink)}`,
      email: `mailto:?subject=${encodeURIComponent('Join our FairShare space')}&body=${encodeURIComponent(`${text}\n${invitationLink}`)}`,
    };
    window.open(urls[target], '_blank', 'noopener,noreferrer');
  }

  async function shareNative() {
    try {
      await navigator.share({ title: 'FairShare invite', text: shareText(), url: invitationLink });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setErrorMessage('Sharing is unavailable on this device. Copy the link instead.');
    }
  }

  async function copyText(text: string, success: string) {
    try {
      // navigator.clipboard only exists on HTTPS/localhost; plain-HTTP network URLs need the legacy fallback.
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        const field = document.createElement('textarea');
        field.value = text;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(field);
        if (!copied) throw new Error('Copy failed');
      }
      notify(success);
    } catch {
      notify('Could not copy automatically. Press and hold the text to copy it.', 'error');
    }
  }

  function copyInvitationLink() {
    return copyText(invitationLink, 'Invitation link copied.');
  }

  async function changeCode(part: 'code' | 'secret', enable: boolean, custom?: string) {
    const slug = activeOrganization?.slug;
    if (!slug) return;
    let confirmation: string | null = null;
    if (part === 'code' && enable && inviteCode) confirmation = 'Make a new invite code? The current code will stop working.';
    if (part === 'code' && !enable) confirmation = 'Turn off joining with a code? Nobody can join this way until you turn it on again.';
    if (part === 'secret' && enable && secretCode && !custom) confirmation = 'Make a new secret code? The current secret will stop working.';
    if (part === 'secret' && !enable) confirmation = 'Turn off the secret code? Anyone who has the invite code could then join.';
    if (confirmation && !(await askConfirm({ title: 'Are you sure?', message: confirmation, confirmLabel: 'Yes, continue', danger: true }))) return;
    setBusy(true);
    try {
      const details = await requestJson<{ code: string | null; secret: string | null }>(`/api/organizations/${encodeURIComponent(slug)}/invite-code`, {
        method: 'POST',
        body: JSON.stringify({ enable, part, ...(custom ? { custom } : {}) }),
      });
      setInviteCode(details.code);
      setSecretCode(details.secret);
      setCustomSecret('');
      if (part === 'code') notify(enable ? 'New invite code ready.' : 'Joining with a code is turned off.');
      else notify(!enable ? 'Secret code turned off.' : custom ? 'Your secret code is saved.' : 'New secret code ready.');
    } catch (error) {
      fail(error, 'Unable to change the code.');
    } finally {
      setBusy(false);
    }
  }

  async function joinWithCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setErrorMessage('');
    try {
      const { organization_slug } = await requestJson<{ organization_slug: string }>('/api/invite-code/join', {
        method: 'POST',
        body: JSON.stringify({ code: joinCode, secret: joinSecret }),
      });
      try { window.localStorage.setItem('fairshare.active-organization', organization_slug); } catch { /* storage unavailable */ }
      window.location.reload();
    } catch (error) {
      setErrorMessage(describeError(error, 'Unable to join with this code.'));
      setBusy(false);
    }
  }

  function resetSpaceState() {
    setAllMembers([]);
    setExpenses([]);
    setSettlementRecords([]);
    setSearch('');
    setDateFrom('');
    setDateTo('');
    setRangePreset('all');
    setInvitationLink('');
  }

  // Reads a receipt photo with AI and prefills the form. The person always reviews and saves it themselves.
  async function scanReceipt(file: File | undefined) {
    const slug = activeOrganization?.slug;
    if (!file || !slug) return;
    setScanning(true);
    setScanNote(null);
    try {
      const image = await prepareReceiptImage(file);
      const { suggestion } = await requestJson<{ suggestion: ReceiptSuggestion }>(
        `/api/organizations/${encodeURIComponent(slug)}/receipts/scan`,
        { method: 'POST', body: JSON.stringify({ image: image.data, media_type: image.media_type }) },
      );
      setForm(current => ({
        ...current,
        title: suggestion.title || current.title,
        amount: suggestion.amount_minor !== null ? amountToInput(suggestion.amount_minor, currency) : current.amount,
        expense_date: suggestion.date ?? current.expense_date,
        category: suggestion.category,
      }));
      const extra = suggestion.notes ? ` ${suggestion.notes}` : '';
      if (suggestion.currency_mismatch) {
        setScanNote({ tone: 'warn', text: `This receipt is in ${suggestion.currency_mismatch}, but this space uses ${currency}. Enter the amount in ${currency} yourself.${extra}` });
      } else if (suggestion.amount_minor === null) {
        setScanNote({ tone: 'warn', text: `Could not read the total with confidence. Please enter the amount.${extra}` });
      } else {
        setScanNote({ tone: suggestion.confidence === 'high' ? 'ok' : 'warn', text: `Filled from your receipt (${suggestion.confidence} confidence). Check everything before saving.${extra}` });
      }
    } catch (error) {
      setScanNote({ tone: 'error', text: describeError(error, 'Could not read this receipt.') });
    } finally {
      setScanning(false);
    }
  }

  async function saveStatementSettings() {
    const slug = activeOrganization?.slug;
    if (!slug || !statementSettings) return;
    setStatementBusy(true);
    setStatementNote(null);
    try {
      const extra = extraEmailsText.split(/[\s,;]+/).map(email => email.trim()).filter(Boolean);
      await requestJson<{ status: string }>(`/api/organizations/${encodeURIComponent(slug)}/statements/settings`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: statementSettings.enabled, day_of_month: statementSettings.day_of_month, recipients_mode: statementSettings.recipients_mode, extra_emails: extra }),
      });
      setStatementNote({ tone: 'ok', text: 'Statement settings saved.' });
    } catch (error) {
      setStatementNote({ tone: 'error', text: describeError(error, 'Unable to save the settings.') });
    } finally {
      setStatementBusy(false);
    }
  }

  async function sendStatementNow(month: string) {
    const slug = activeOrganization?.slug;
    if (!slug) return;
    if (!(await askConfirm({ title: 'Send statement now?', message: `Email the ${monthRange(month).label} statement now to the people in the settings?`, confirmLabel: 'Send now' }))) return;
    setStatementBusy(true);
    setStatementNote(null);
    try {
      const result = await requestJson<{ sent: number; failed: number; month: string }>(`/api/organizations/${encodeURIComponent(slug)}/statements/send`, {
        method: 'POST',
        body: JSON.stringify({ month }),
      });
      setStatementNote({ tone: result.failed ? 'error' : 'ok', text: `${result.month} statement sent to ${result.sent} ${result.sent === 1 ? 'person' : 'people'}${result.failed ? `; ${result.failed} could not be reached` : ''}.` });
    } catch (error) {
      setStatementNote({ tone: 'error', text: describeError(error, 'Unable to send the statement.') });
    } finally {
      setStatementBusy(false);
    }
  }

  function openBulk() {
    closeExpenseForm();
    setBulkRows([]);
    setBulkNote(null);
    setShowBulk(true);
  }

  // The person named on an entry becomes the payer when it matches a member; otherwise it is you.
  function payerFor(personName: string | null): string {
    const fallback = members.some(member => member.user_id === userId) ? userId : members[0]?.user_id ?? '';
    const wanted = personName?.trim().toLowerCase();
    if (!wanted || wanted.length < 3) return fallback;
    const match = members.find(member => {
      const name = memberLabel(member.user_id).toLowerCase();
      return name.includes(wanted) || (name.length >= 3 && wanted.includes(name));
    });
    return match?.user_id ?? fallback;
  }

  // Reads photos of a list, an invoice or a payment history. Nothing is saved until the person reviews the rows.
  async function scanMany(files: FileList | null) {
    const slug = activeOrganization?.slug;
    const chosen = Array.from(files ?? []).slice(0, 4);
    if (!chosen.length || !slug) return;
    setBulkScanning(true);
    setBulkNote(null);
    try {
      const images = await Promise.all(chosen.map(file => prepareReceiptImage(file)));
      const result = await requestJson<{ source: string; entries: EntrySuggestion[]; notes: string }>(
        `/api/organizations/${encodeURIComponent(slug)}/receipts/scan-many`,
        { method: 'POST', body: JSON.stringify({ images: images.map(image => ({ data: image.data, media_type: image.media_type })) }) },
      );
      const duplicates = markDuplicates(result.entries, expenses);
      const rows = result.entries.map<BulkRow>((entry, index) => ({
        key: `${Date.now()}-${index}`,
        include: entry.direction !== 'received' && entry.amount_minor !== null && duplicates[index] === null && !entry.currency_mismatch,
        title: entry.title,
        description: entry.description,
        amount: entry.amount_minor !== null ? amountToInput(entry.amount_minor, currency) : '',
        date: entry.date ?? today(),
        category: entry.category,
        payerId: payerFor(entry.person_name),
        duplicate: duplicates[index],
        direction: entry.direction,
        confidence: entry.confidence,
        problem: entry.currency_mismatch ? `In ${entry.currency_mismatch}, not ${currency}. Enter the amount yourself.` : '',
      }));
      setBulkRows(rows);
      setBulkNote(rows.length
        ? { tone: 'ok', text: `Found ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}. Check each one, untick what you do not want, then add them. ${result.notes}`.trim() }
        : { tone: 'warn', text: `No expenses were found in the photos. ${result.notes}`.trim() });
    } catch (error) {
      setBulkNote({ tone: 'error', text: describeError(error, 'Could not read these photos.') });
    } finally {
      setBulkScanning(false);
    }
  }

  function updateBulkRow(key: string, patch: Partial<BulkRow>) {
    setBulkRows(current => current.map(row => row.key === key ? { ...row, ...patch, problem: '' } : row));
  }

  async function saveBulk() {
    const slug = activeOrganization?.slug;
    if (!slug) return;
    const activeIds = new Set(members.map(member => member.user_id));
    let invalid = false;
    const checked = bulkRows.map(row => {
      if (!row.include) return row;
      let problem = '';
      if (!row.title.trim()) problem = 'Add a name.';
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) problem = 'Choose a date.';
      else if (!activeIds.has(row.payerId)) problem = 'Choose who paid.';
      else {
        try { parseMinorUnits(row.amount, currency); } catch (error) { problem = describeError(error, 'Enter a valid amount.'); }
      }
      if (problem) invalid = true;
      return { ...row, problem };
    });
    setBulkRows(checked);
    if (invalid) {
      setBulkNote({ tone: 'warn', text: 'Fix the rows marked in red, or untick them, then try again.' });
      return;
    }
    setBulkSaving(true);
    setBulkNote(null);
    let added = 0;
    const remaining: BulkRow[] = [];
    for (const row of checked) {
      if (!row.include) continue;
      try {
        await requestJson<{ expense_id: string }>(`/api/organizations/${encodeURIComponent(slug)}/expenses`, {
          method: 'POST',
          body: JSON.stringify({
            title: row.title.trim(),
            description: row.description.trim() || undefined,
            amount_minor: parseMinorUnits(row.amount, currency),
            currency,
            expense_date: row.date,
            payer_id: row.payerId,
            category: row.category,
            split_scope: 'group',
            split_method: 'equal',
          }),
        });
        added += 1;
      } catch (error) {
        remaining.push({ ...row, problem: describeError(error, 'Could not save this one.') });
      }
    }
    await reloadExpenses(slug).catch(() => undefined);
    setBulkSaving(false);
    if (remaining.length === 0) {
      setShowBulk(false);
      setBulkRows([]);
      notify(`${added} ${added === 1 ? 'expense' : 'expenses'} added.`);
    } else {
      setBulkRows(remaining);
      setBulkNote({ tone: 'warn', text: `${added} added. ${remaining.length} could not be saved; they are listed below.` });
    }
  }

  function openProfile() {
    setErrorMessage('');
    setProfileForm({ name: profile?.display_name || userName, phone: profile?.phone ?? '' });
    setShowProfile(true);
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setErrorMessage('');
    try {
      const saved = await requestJson<{ display_name: string; phone: string | null }>('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({ display_name: profileForm.name, phone: profileForm.phone }),
      });
      setProfile(current => ({ display_name: saved.display_name, phone: saved.phone, email: current?.email ?? null }));
      setUserName(saved.display_name);
      setShowProfile(false);
      const slug = activeOrganization?.slug;
      if (slug) void refreshSpace(slug).catch(() => undefined);
      notify('Profile updated.');
    } catch (error) {
      setErrorMessage(describeError(error, 'Unable to save your profile.'));
    } finally {
      setBusy(false);
    }
  }

  function startCreateSpace() {
    if (managesASpace) {
      setErrorMessage('You already manage a space. To create another, first make someone else an admin of it and leave.');
      return;
    }
    setErrorMessage('');
    setShowOrgForm(true);
  }

  function switchOrganization(slug: string) {
    // Re-selecting the open space must not wipe its data: the load effect only re-runs when the slug changes.
    if (slug === activeSlug) {
      setShowOrgMenu(false);
      return;
    }
    setActiveSlug(slug);
    resetSpaceState();
    try { window.localStorage.setItem('fairshare.active-organization', slug); } catch { /* storage unavailable */ }
    setShowOrgMenu(false);
    setView('overview');
  }

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setErrorMessage('');
    const slug = orgSlug.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    try {
      const { organization } = await requestJson<{ organization: Organization }>('/api/organizations', {
        method: 'POST',
        body: JSON.stringify({ name: orgName.trim(), slug, type: orgType, currency: 'INR', timezone: 'Asia/Kolkata' }),
      });
      setOrganizations(current => [{ ...organization, organization_members: [{ role: 'admin', status: 'active' }] }, ...current]);
      switchOrganization(organization.slug);
      setShowOrgForm(false);
      setOrgName('');
      setOrgSlug('');
      notify('Your shared space is ready.');
    } catch (error) {
      setErrorMessage(describeError(error, 'Unable to create the shared space.'));
    } finally {
      setBusy(false);
    }
  }

  function openExpenseForm() {
    setErrorMessage('');
    setEditingExpense(null);
    setScanNote(null);
    setSplitScope('group');
    setSplitValues({});
    setForm(current => ({ ...current, title: '', amount: '', expense_date: today() }));
    setShowExpenseForm(true);
  }

  function openEditForm(expense: Expense) {
    if (expense.split_scope === 'group') {
      // Group expenses are re-divided by the database, so only the basic details are edited here.
      setErrorMessage('');
      setEditingExpense(expense);
      setSplitScope('group');
      setSplitValues({});
      setForm({
        title: expense.title,
        amount: amountToInput(expense.amount_minor, expense.currency),
        expense_date: expense.expense_date,
        payer_id: members.some(member => member.user_id === expense.payer_id) ? expense.payer_id : form.payer_id,
        category: expense.category,
      });
      setShowExpenseForm(true);
      return;
    }
    const activeIds = new Set(members.map(member => member.user_id));
    if (!activeIds.has(expense.payer_id) || expense.expense_splits.some(split => !activeIds.has(split.member_id))) {
      setErrorMessage('This expense includes a former member, so it cannot be edited. Delete it and add it again instead.');
      return;
    }
    const mode = inferSplitMode(expense);
    setErrorMessage('');
    setEditingExpense(expense);
    setSplitScope('selected');
    setSplitMode(mode);
    setParticipantIds(expense.expense_splits.map(split => split.member_id));
    setSplitValues(mode === 'exact'
      ? Object.fromEntries(expense.expense_splits.map(split => [split.member_id, amountToInput(split.amount_minor, expense.currency)]))
      : {});
    setForm({
      title: expense.title,
      amount: amountToInput(expense.amount_minor, expense.currency),
      expense_date: expense.expense_date,
      payer_id: expense.payer_id,
      category: expense.category,
    });
    setShowExpenseForm(true);
  }

  function selectRange(key: 'all' | 'month' | 'last30' | 'custom') {
    setRangePreset(key);
    const now = new Date();
    if (key === 'all') { setDateFrom(''); setDateTo(''); }
    if (key === 'month') { setDateFrom(startOfMonth(now)); setDateTo(today()); }
    if (key === 'last30') { setDateFrom(daysAgo(now, 30)); setDateTo(today()); }
  }

  function closeExpenseForm() {
    setShowExpenseForm(false);
    setEditingExpense(null);
  }

  function buildSplits(amountMinor: number, activeCurrency: string) {
    if (splitMode === 'equal') return splitEqually(amountMinor, participantIds);
    if (splitMode === 'shares') {
      return splitByWeights(amountMinor, participantIds.map(memberId => {
        const weight = Number(splitValues[memberId] ?? '1');
        if (!Number.isFinite(weight) || weight <= 0) throw new Error('Enter a share greater than zero for everyone selected.');
        return { memberId, weight };
      }));
    }
    const exact = participantIds.map(memberId => ({
      memberId,
      amountMinor: splitValues[memberId]?.trim() ? parseMinorUnits(splitValues[memberId], activeCurrency) : 0,
    }));
    const assigned = exact.reduce((sum, split) => sum + split.amountMinor, 0);
    if (assigned !== amountMinor) {
      throw new Error(`Exact amounts add up to ${formatMinorUnits(assigned, activeCurrency)}, but the expense is ${formatMinorUnits(amountMinor, activeCurrency)}.`);
    }
    return exact;
  }

  async function submitExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganization) return;
    const isGroup = splitScope === 'group';
    if (!form.payer_id || (!isGroup && !participantIds.length)) {
      setErrorMessage('Choose a payer and at least one person to split between.');
      return;
    }
    setBusy(true);
    setErrorMessage('');
    const slug = activeOrganization.slug;
    try {
      const amountMinor = parseMinorUnits(form.amount, activeOrganization.currency);
      const splits = isGroup ? [] : buildSplits(amountMinor, activeOrganization.currency);
      const payload = {
        title: form.title.trim(),
        amount_minor: amountMinor,
        expense_date: form.expense_date,
        payer_id: form.payer_id,
        category: form.category,
        split_scope: splitScope,
        split_method: isGroup || splitMode === 'equal' ? 'equal' : splitMode === 'shares' ? 'weighted' : 'custom',
        splits: splits.map(split => ({ member_id: split.memberId, amount_minor: split.amountMinor })),
      };
      if (editingExpense) {
        await requestJson<{ status: string }>(
          `/api/organizations/${encodeURIComponent(slug)}/expenses/${encodeURIComponent(editingExpense.id)}`,
          { method: 'PATCH', body: JSON.stringify({ ...payload, expected_updated_at: editingExpense.updated_at }) },
        );
      } else {
        await requestJson<{ expense_id: string }>(`/api/organizations/${encodeURIComponent(slug)}/expenses`, {
          method: 'POST',
          body: JSON.stringify({ ...payload, currency: activeOrganization.currency }),
        });
        if (!isGroup) try {
          window.localStorage.setItem(preferencesKey(slug), JSON.stringify({
            payerId: form.payer_id,
            participantIds,
            category: form.category,
            splitMode,
          }));
        } catch { /* storage unavailable */ }
      }
      await reloadExpenses(slug);
      const wasEditing = Boolean(editingExpense);
      closeExpenseForm();
      setSplitValues({});
      setForm(current => ({ ...current, title: '', amount: '', expense_date: today() }));
      if (wasEditing) {
        setSplitMode('equal');
        notify('Expense updated.');
      } else {
        notify('Expense saved for everyone in this space.');
      }
    } catch (error) {
      const message = describeError(error, 'Unable to save the expense.');
      setErrorMessage(message);
      if (message.includes('changed by someone else')) void reloadExpenses(slug).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function deleteExpense(expense: Expense) {
    const slug = activeOrganization?.slug;
    if (!slug || !(await askConfirm({ title: 'Delete this expense?', message: `“${expense.title}” will be removed and balances will be recalculated.`, confirmLabel: 'Delete', danger: true }))) return;
    setBusy(true);
    setErrorMessage('');
    try {
      await requestJson<{ status: string }>(
        `/api/organizations/${encodeURIComponent(slug)}/expenses/${encodeURIComponent(expense.id)}`,
        { method: 'DELETE' },
      );
      setExpenses(current => current.filter(item => item.id !== expense.id));
      notify('Expense deleted.');
    } catch (error) {
      setErrorMessage(describeError(error, 'Unable to delete the expense.'));
    } finally {
      setBusy(false);
    }
  }

  async function bulkDeleteExpenses() {
    const slug = activeOrganization?.slug;
    if (!slug || !rangeExpenses.length) return;
    setBusy(true);
    setErrorMessage('');
    try {
      const { deleted } = await requestJson<{ deleted: number }>(
        `/api/organizations/${encodeURIComponent(slug)}/expenses/bulk-delete`,
        {
          method: 'POST',
          body: JSON.stringify({
            from: dateFrom || '1900-01-01',
            to: dateTo || '2999-12-31',
            include_settlements: bulkIncludePayments,
          }),
        },
      );
      await Promise.all([reloadExpenses(slug), reloadSettlements(slug)]);
      setShowBulkDelete(false);
      setBulkConfirmText('');
      setBulkIncludePayments(false);
      notify(`${deleted} ${deleted === 1 ? 'expense' : 'expenses'} deleted.`);
    } catch (error) {
      setErrorMessage(describeError(error, 'Unable to delete these expenses.'));
    } finally {
      setBusy(false);
    }
  }

  async function changeMemberRole(member: Member, role: MemberRole | 'owner') {
    const slug = activeOrganization?.slug;
    if (!slug || role === member.role) return;
    if (role === 'owner' && !(await askConfirm({ title: 'Transfer ownership?', message: `Make ${memberLabel(member.user_id)} the owner of “${activeOrganization?.name}”? You will become a regular member and can then leave if you wish.`, confirmLabel: 'Make owner', danger: true }))) {
      void reloadMembers(slug).catch(() => undefined);
      return;
    }
    setBusy(true);
    setErrorMessage('');
    try {
      await requestJson<{ role: string }>(
        `/api/organizations/${encodeURIComponent(slug)}/members/${encodeURIComponent(member.user_id)}`,
        { method: 'PATCH', body: JSON.stringify({ role }) },
      );
      await reloadMembers(slug);
      notify(role === 'owner' ? `${memberLabel(member.user_id)} is now the owner.` : `${memberLabel(member.user_id)} is now ${roleLabels[role].toLowerCase()}.`);
    } catch (error) {
      fail(error, 'Unable to change this role.');
      void reloadMembers(slug).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function changeShareFrom(member: Member, shareFrom: string | null) {
    const slug = activeOrganization?.slug;
    if (!slug || (member.share_from ?? null) === shareFrom) return;
    setBusy(true);
    setErrorMessage('');
    try {
      await requestJson<{ share_from: string | null }>(
        `/api/organizations/${encodeURIComponent(slug)}/members/${encodeURIComponent(member.user_id)}`,
        { method: 'PATCH', body: JSON.stringify({ share_from: shareFrom }) },
      );
      // Group expenses are re-divided by the database, so reload them along with the members.
      await Promise.all([reloadMembers(slug), reloadExpenses(slug)]);
      notify(shareFrom ? `${memberLabel(member.user_id)} now shares group expenses from ${formatDate(shareFrom)}.` : `${memberLabel(member.user_id)} now shares all group expenses.`);
    } catch (error) {
      fail(error, 'Unable to change the start date.');
      void reloadMembers(slug).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(member: Member) {
    const slug = activeOrganization?.slug;
    if (!slug) return;
    const leaving = member.user_id === userId;
    const confirmation = leaving
      ? `Leave “${activeOrganization?.name}”? You will lose access unless someone invites you again.`
      : `Remove ${memberLabel(member.user_id)} from “${activeOrganization?.name}”? They will lose access.`;
    if (!(await askConfirm({ title: leaving ? 'Leave this space?' : 'Remove this member?', message: confirmation, confirmLabel: leaving ? 'Leave' : 'Remove', danger: true }))) return;
    setBusy(true);
    setErrorMessage('');
    try {
      await requestJson<{ status: string }>(
        `/api/organizations/${encodeURIComponent(slug)}/members/${encodeURIComponent(member.user_id)}`,
        { method: 'DELETE' },
      );
      if (leaving) {
        const remaining = organizations.filter(organization => organization.slug !== slug);
        setOrganizations(remaining);
        resetSpaceState();
        setActiveSlug(remaining[0]?.slug ?? '');
        setView('overview');
        notify('You left the space.');
      } else {
        await reloadMembers(slug);
        notify('Member removed.');
      }
    } catch (error) {
      fail(error, 'Unable to remove this member.');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      const { error } = await createSupabaseBrowserClient().auth.signOut();
      if (error) throw error;
      router.replace('/login');
      router.refresh();
    } catch (error) {
      setErrorMessage(describeError(error, 'Unable to sign out.'));
      setBusy(false);
    }
  }

  if (initialLoading) {
    return <main className={styles.loading}><LoaderCircle size={24} className={styles.spinner} />Loading your shared spaces…</main>;
  }

  if (!organizations.length) {
    return (
      <main className={styles.onboarding}>
        <div className={styles.onboardingCard}>
          <div className={styles.logoMark}><Command size={21} /></div>
          <span className={styles.eyebrow}>WELCOME TO FAIRSHARE</span>
          <h1>Make shared spending feel simple.</h1>
          <p>Start a private space for your trip, home, or group, or join one that already exists with its invite code.</p>
          {errorMessage && !showJoin && <p className={styles.error} role="alert">{errorMessage}</p>}
          <div className={styles.onboardingChoices}>
            <button className={styles.primaryButton} onClick={() => { setErrorMessage(''); setShowOrgForm(true); }}><Plus size={17} />Create a new space</button>
            <button className={styles.secondaryButton} onClick={() => { setErrorMessage(''); setJoinCode(''); setJoinSecret(''); setShowJoin(true); }}>I have an invite code</button>
          </div>
          <button className={styles.signOutLink} onClick={() => void signOut()}><LogOut size={15} />Sign out</button>
        </div>
        {showOrgForm && renderOrganizationDialog()}
        {showJoin && renderJoinDialog()}
      </main>
    );
  }

  if (!activeOrganization) {
    return <main className={styles.loading}><LoaderCircle size={24} className={styles.spinner} />Opening your shared space…</main>;
  }

  function renderBulkDialog() {
    const included = bulkRows.filter(row => row.include);
    let total = 0;
    for (const row of included) { try { total += parseMinorUnits(row.amount, currency); } catch { /* shown as a problem on save */ } }
    return (
      <div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget && !bulkSaving) setShowBulk(false); }}>
        <section className={`${styles.dialog} ${styles.dialogWide}`} role="dialog" aria-modal="true" aria-labelledby="bulk-add-title">
          <div className={styles.dialogHeader}><div><span className={styles.eyebrow}>ADD FROM PHOTOS</span><h2 id="bulk-add-title">Many expenses at once</h2><p>Photograph a notebook list, an invoice (Blinkit, Flipkart Minutes and similar) or a Paytm / UPI payment history. Up to 4 photos.</p></div><button className={styles.closeButton} aria-label="Close dialog" disabled={bulkSaving} onClick={() => setShowBulk(false)}><X size={18} /></button></div>
          <div className={styles.scanBox}>
            <label className={`${styles.scanButton} ${bulkScanning ? styles.scanBusy : ''}`}>
              <input type="file" accept="image/*" multiple hidden disabled={bulkScanning || bulkSaving} onChange={event => { void scanMany(event.target.files); event.target.value = ''; }} />
              {bulkScanning ? <LoaderCircle size={17} className={styles.spinner} /> : <Camera size={17} />}
              {bulkScanning ? 'Reading photos…' : bulkRows.length ? 'Scan more photos' : 'Choose photos'}
            </label>
            <span className={styles.hint}>The photos are sent to an AI service to read them and are not stored. Nothing is added until you review it.</span>
            {bulkNote && <p className={bulkNote.tone === 'error' ? styles.error : bulkNote.tone === 'warn' ? styles.splitWarning : styles.scanOk} role="status">{bulkNote.text}</p>}
          </div>
          {bulkRows.length > 0 && <div className={styles.bulkList}>
            {bulkRows.map(row => (
              <article key={row.key} className={`${styles.bulkRow} ${row.include ? '' : styles.bulkOff} ${row.problem ? styles.bulkProblem : ''}`}>
                <div className={styles.bulkTop}>
                  <input type="checkbox" checked={row.include} onChange={event => setBulkRows(current => current.map(item => item.key === row.key ? { ...item, include: event.target.checked } : item))} aria-label={`Include ${row.title || 'this entry'}`} />
                  <input className={styles.bulkTitle} value={row.title} onChange={event => updateBulkRow(row.key, { title: event.target.value })} maxLength={140} placeholder="Name" aria-label="Name" />
                  <input className={styles.bulkAmount} value={row.amount} onChange={event => updateBulkRow(row.key, { amount: event.target.value })} inputMode="decimal" placeholder="0.00" aria-label="Amount" />
                </div>
                <div className={styles.bulkMeta}>
                  <input type="date" value={row.date} onChange={event => updateBulkRow(row.key, { date: event.target.value })} aria-label="Date" />
                  <select value={row.category} onChange={event => updateBulkRow(row.key, { category: event.target.value })} aria-label="Category">{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                  <select value={row.payerId} onChange={event => updateBulkRow(row.key, { payerId: event.target.value })} aria-label="Paid by">{members.map(member => <option key={member.user_id} value={member.user_id}>{memberLabel(member.user_id)}{member.user_id === userId ? ' (you)' : ''}</option>)}</select>
                </div>
                <input className={styles.bulkDescription} value={row.description} onChange={event => updateBulkRow(row.key, { description: event.target.value })} maxLength={300} placeholder="Description (optional)" aria-label="Description" />
                <div className={styles.bulkBadges}>
                  {row.direction === 'received' && <span className={styles.bulkBadge}>Money received</span>}
                  {row.duplicate === 'existing' && <span className={styles.bulkBadge}>Possible duplicate: same date and amount already saved</span>}
                  {row.duplicate === 'repeat' && <span className={styles.bulkBadge}>Possible duplicate: appears twice in these photos</span>}
                  {row.confidence === 'low' && <span className={styles.bulkBadge}>Hard to read, please check</span>}
                  {row.problem && <span className={styles.bulkError}>{row.problem}</span>}
                </div>
              </article>
            ))}
          </div>}
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondaryButton} disabled={bulkSaving} onClick={() => setShowBulk(false)}>Cancel</button>
            <button type="button" className={styles.primaryButton} disabled={bulkSaving || bulkScanning || included.length === 0} onClick={() => void saveBulk()}>{bulkSaving ? 'Adding…' : `Add ${included.length} ${included.length === 1 ? 'expense' : 'expenses'}${included.length ? ` · ${formatMinorUnits(total, currency)}` : ''}`}</button>
          </div>
          {included.length > 0 && <p className={styles.hint}>Each expense is split equally across the whole group. You can edit any of them afterwards.</p>}
        </section>
      </div>
    );
  }

  function renderJoinDialog() {
    return (
      <div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget) setShowJoin(false); }}>
        <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="join-dialog-title">
          <div className={styles.dialogHeader}><div><span className={styles.eyebrow}>JOIN A SPACE</span><h2 id="join-dialog-title">Enter your invite code</h2><p>Ask the owner or an admin of the space for the invite code and the secret code. You join as a member right away.</p></div><button className={styles.closeButton} aria-label="Close dialog" onClick={() => setShowJoin(false)}><X size={18} /></button></div>
          <form onSubmit={joinWithCode} className={styles.form}>
            <label>Invite code<input className={styles.codeInput} value={joinCode} onChange={event => setJoinCode(formatInviteCode(event.target.value))} placeholder="A1B2-C3D4-E5F6" autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false} inputMode="text" required autoFocus /></label>
            <label>Secret code<input className={styles.codeInput} value={joinSecret} onChange={event => setJoinSecret(formatSecretCode(event.target.value))} placeholder="Given to you by the admin" autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false} /><span className={styles.hint}>Needed unless the admin turned the secret off.</span></label>
            {errorMessage && <p className={styles.error} role="alert">{errorMessage}</p>}
            <div className={styles.dialogActions}><button type="button" className={styles.secondaryButton} onClick={() => setShowJoin(false)}>Cancel</button><button type="submit" className={styles.primaryButton} disabled={busy || !isValidInviteCode(joinCode) || (joinSecret !== '' && !isValidSecretCode(joinSecret))}>{busy ? 'Joining…' : 'Join space'}</button></div>
          </form>
        </section>
      </div>
    );
  }

  function renderOrganizationDialog() {
    return (
      <div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget) setShowOrgForm(false); }}>
        <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="org-dialog-title">
          <div className={styles.dialogHeader}><div><span className={styles.eyebrow}>NEW SHARED SPACE</span><h2 id="org-dialog-title">Bring your group together</h2></div><button className={styles.closeButton} aria-label="Close dialog" onClick={() => setShowOrgForm(false)}><X size={18} /></button></div>
          <form onSubmit={createOrganization} className={styles.form}>
            <label>Space name<input value={orgName} onChange={event => { setOrgName(event.target.value); setOrgSlug(event.target.value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }} minLength={2} maxLength={80} required placeholder="e.g. Goa getaway" /></label>
            <label>Short link<input value={orgSlug} onChange={event => setOrgSlug(event.target.value)} minLength={2} maxLength={70} pattern="[a-z0-9]+(-[a-z0-9]+)*" required placeholder="goa-getaway" /><span className={styles.hint}>Lowercase letters, numbers, and hyphens.</span></label>
            <label>What is this space for?<select value={orgType} onChange={event => setOrgType(event.target.value)}><option value="trip">Trip</option><option value="room">Shared home</option><option value="party">Event</option><option value="personal">Personal</option><option value="custom">Other</option></select></label>
            {errorMessage && <p className={styles.error} role="alert">{errorMessage}</p>}
            <div className={styles.dialogActions}><button type="button" className={styles.secondaryButton} onClick={() => setShowOrgForm(false)}>Cancel</button><button type="submit" className={styles.primaryButton} disabled={busy}>{busy ? 'Creating…' : 'Create space'}</button></div>
          </form>
        </section>
      </div>
    );
  }

  function splitPreview(): string {
    try {
      const amountMinor = parseMinorUnits(form.amount, currency);
      if (splitScope === 'group') {
        const sharing = eligibleGroupMemberIds(members, form.expense_date);
        if (!sharing.length) return 'Nobody shares expenses from this date yet. Pick a later date.';
        const later = members.length - sharing.length;
        return `About ${formatMinorUnits(splitEqually(amountMinor, sharing)[0].amountMinor, currency)} each across ${sharing.length} ${sharing.length === 1 ? 'person' : 'people'}.${later > 0 ? ` ${later} ${later === 1 ? 'member who joined' : 'members who joined'} later ${later === 1 ? 'is' : 'are'} not part of this date.` : ''}`;
      }
      if (splitMode === 'exact') {
        const assigned = participantIds.reduce((sum, id) => {
          const raw = splitValues[id]?.trim();
          return sum + (raw ? parseMinorUnits(raw, currency) : 0);
        }, 0);
        const remaining = amountMinor - assigned;
        return remaining === 0
          ? 'Amounts add up perfectly.'
          : remaining > 0
            ? `${formatMinorUnits(remaining, currency)} still to assign.`
            : `${formatMinorUnits(-remaining, currency)} too much assigned.`;
      }
      if (!participantIds.length) return '';
      if (splitMode === 'equal') {
        const first = splitEqually(amountMinor, participantIds)[0].amountMinor;
        return `About ${formatMinorUnits(first, currency)} each.`;
      }
      return '';
    } catch {
      return '';
    }
  }

  function renderExpenseDialog() {
    if (!activeOrganization) return null;
    const preview = splitPreview();
    return (
      <div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget) closeExpenseForm(); }}>
        <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="expense-dialog-title">
          <div className={styles.dialogHeader}><div><span className={styles.eyebrow}>{editingExpense ? 'EDIT TRANSACTION' : 'NEW TRANSACTION'}</span><h2 id="expense-dialog-title">{editingExpense ? 'Edit expense' : 'Add an expense'}</h2><p>Split evenly, by shares, or with exact amounts per person.</p></div><button className={styles.closeButton} aria-label="Close dialog" onClick={closeExpenseForm}><X size={18} /></button></div>
          <form onSubmit={submitExpense} className={styles.form}>
            {!editingExpense && <div className={styles.scanBox}>
              <label className={`${styles.scanButton} ${scanning ? styles.scanBusy : ''}`}>
                <input type="file" accept="image/*" hidden disabled={scanning} onChange={event => { void scanReceipt(event.target.files?.[0]); event.target.value = ''; }} />
                {scanning ? <LoaderCircle size={17} className={styles.spinner} /> : <Camera size={17} />}
                {scanning ? 'Reading receipt…' : 'Scan a receipt with AI'}
              </label>
              <span className={styles.hint}>Take or choose a photo and we fill in the details for you to check. The photo is sent to an AI service to read it and is not stored.</span>
              <button type="button" className={styles.scanLink} onClick={openBulk}>Many entries? Add from a list, invoice or payment history →</button>
              {scanNote && <p className={scanNote.tone === 'error' ? styles.error : scanNote.tone === 'warn' ? styles.splitWarning : styles.scanOk} role="status">{scanNote.text}</p>}
            </div>}
            <label>What was this for?<input value={form.title} onChange={event => setForm(current => ({ ...current, title: event.target.value }))} maxLength={140} required placeholder="Dinner, groceries, rent…" /></label>
            <div className={styles.formRow}><label>Amount ({activeOrganization.currency})<input type="number" min="0.01" step="0.01" inputMode="decimal" value={form.amount} onChange={event => setForm(current => ({ ...current, amount: event.target.value }))} required placeholder="0.00" /></label><label>Date<input type="date" value={form.expense_date} onChange={event => setForm(current => ({ ...current, expense_date: event.target.value }))} required /></label></div>
            <div className={styles.formRow}><label>Paid by<select value={form.payer_id} onChange={event => setForm(current => ({ ...current, payer_id: event.target.value }))} required>{members.map(member => <option key={member.user_id} value={member.user_id}>{memberLabel(member.user_id)}{member.user_id === userId ? ' (you)' : ''}</option>)}</select></label><label>Category<select value={form.category} onChange={event => setForm(current => ({ ...current, category: event.target.value }))}>{Object.entries(categoryLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
            <div className={styles.scopeToggle} role="group" aria-label="Who shares this expense">
              <button type="button" aria-pressed={splitScope === 'group'} className={splitScope === 'group' ? styles.scopeActive : ''} onClick={() => setSplitScope('group')}>Whole group</button>
              <button type="button" aria-pressed={splitScope === 'selected'} className={splitScope === 'selected' ? styles.scopeActive : ''} onClick={() => setSplitScope('selected')}>Selected people</button>
            </div>
            <p className={styles.scopeHint}>{splitScope === 'group' ? 'Split equally between everyone in the group, including people who join later.' : 'Choose exactly who shares this expense.'}</p>
            {splitScope === 'selected' && <label>Split<select value={splitMode} onChange={event => setSplitMode(event.target.value as SplitMode)}>{(Object.keys(splitModeLabels) as SplitMode[]).map(mode => <option key={mode} value={mode}>{splitModeLabels[mode]}</option>)}</select></label>}
            {splitScope === 'selected' && <fieldset className={styles.participants}>
              <legend>Split between</legend>
              <div className={styles.participantTools}>
                <button type="button" onClick={() => setParticipantIds(members.map(member => member.user_id))} disabled={participantIds.length === members.length}>Select all</button>
                <button type="button" onClick={() => setParticipantIds([])} disabled={!participantIds.length}>Clear</button>
                <span>{participantIds.length} of {members.length} selected</span>
              </div>
              {members.length === 0 ? <p>No active members yet.</p> : members.map(member => <label key={member.user_id}><input type="checkbox" checked={participantIds.includes(member.user_id)} onChange={event => setParticipantIds(current => event.target.checked ? [...current, member.user_id] : current.filter(id => id !== member.user_id))} /><span>{memberLabel(member.user_id)}{member.user_id === userId ? ' (you)' : ''}</span>{splitMode !== 'equal' && participantIds.includes(member.user_id) && <input className={styles.splitInput} type="number" min={splitMode === 'shares' ? '0.01' : '0'} step={splitMode === 'shares' ? 'any' : '0.01'} inputMode="decimal" aria-label={`${splitMode === 'shares' ? 'Shares' : 'Amount'} for ${memberLabel(member.user_id)}`} placeholder={splitMode === 'shares' ? '1' : '0.00'} value={splitValues[member.user_id] ?? ''} onChange={event => setSplitValues(current => ({ ...current, [member.user_id]: event.target.value }))} />}</label>)}
            </fieldset>}
            {preview && <p className={styles.splitPreview} role="status">{preview}</p>}
            {splitScope === 'selected' && participantIds.length > 0 && participantIds.length < members.length && <p className={styles.splitWarning} role="status">Only {participantIds.length} of {members.length} people will share this expense. The others will not pay for it.</p>}
            {errorMessage && <p className={styles.error} role="alert">{errorMessage}</p>}
            <div className={styles.dialogActions}><button type="button" className={styles.secondaryButton} onClick={closeExpenseForm}>Cancel</button><button type="submit" className={styles.primaryButton} disabled={busy || !members.length}>{busy ? 'Saving…' : editingExpense ? 'Save changes' : 'Save expense'}</button></div>
          </form>
        </section>
      </div>
    );
  }

  function renderProfileDialog() {
    return (
      <div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget) setShowProfile(false); }}>
        <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="profile-dialog-title">
          <div className={styles.dialogHeader}><div><span className={styles.eyebrow}>YOUR PROFILE</span><h2 id="profile-dialog-title">Edit your details</h2><p>Admins of your spaces can see your email and mobile number to identify you.</p></div><button className={styles.closeButton} aria-label="Close dialog" onClick={() => setShowProfile(false)}><X size={18} /></button></div>
          <form onSubmit={saveProfile} className={styles.form}>
            <label>Full name<input value={profileForm.name} onChange={event => setProfileForm(current => ({ ...current, name: event.target.value }))} minLength={2} maxLength={100} required autoComplete="name" placeholder="e.g. Vansh Gupta" /></label>
            <label>Mobile number<input type="tel" inputMode="tel" autoComplete="tel" value={profileForm.phone} onChange={event => setProfileForm(current => ({ ...current, phone: event.target.value }))} maxLength={40} placeholder="+91 98765 43210" /><span className={styles.hint}>Optional. Include the country code, or enter a 10-digit Indian number.</span></label>
            <label>Email<input value={profile?.email ?? ''} readOnly disabled /><span className={styles.hint}>Your sign-in email cannot be changed here.</span></label>
            {currentRole === 'admin' && <div className={styles.codeCard}>
              <div><h3>Secret code for {activeOrganization?.name}</h3><p>Only you and the other admins can see this. A person needs the invite code and this secret to join, so give it to them personally and not in the group chat.</p></div>
              {secretCode === undefined
                ? <p className={styles.hint}>Loading…</p>
                : secretCode
                  ? <div className={styles.codeRow}><code className={styles.codeValue}>{showSecret ? formatSecretCode(secretCode) : '•••••••••••'}</code><button type="button" className={styles.copyButton} aria-label={showSecret ? 'Hide secret code' : 'Show secret code'} onClick={() => setShowSecret(current => !current)}>{showSecret ? <EyeOff size={16} /> : <Eye size={16} />}</button><button type="button" className={styles.copyButton} aria-label="Copy secret code" onClick={() => void copyText(formatSecretCode(secretCode), 'Secret code copied.')}><Copy size={16} /></button></div>
                  : <p className={styles.hint}>{inviteCode ? 'No secret code: the invite code alone admits people.' : 'Joining with a code is turned off.'}</p>}
              {inviteCode && <>
                <div className={styles.codeActions}>
                  <button type="button" className={styles.linkButton} disabled={busy} onClick={() => void changeCode('secret', true)}>{secretCode ? 'Make a new secret' : 'Turn on the secret'}</button>
                  {secretCode && <button type="button" className={styles.linkButton} disabled={busy} onClick={() => void changeCode('secret', false)}>Turn off the secret</button>}
                </div>
                <div className={styles.customSecret}>
                  <input value={customSecret} onChange={event => setCustomSecret(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} placeholder="Or type your own (8-32 letters or digits)" maxLength={40} autoComplete="off" spellCheck={false} aria-label="Your own secret code" />
                  <button type="button" className={styles.secondaryButton} disabled={busy || normalizeInviteCode(customSecret).length < 8} onClick={() => void changeCode('secret', true, customSecret)}>Save</button>
                </div>
              </>}
            </div>}
            {errorMessage && <p className={styles.error} role="alert">{errorMessage}</p>}
            <div className={styles.dialogActions}><button type="button" className={styles.secondaryButton} onClick={() => setShowProfile(false)}>Cancel</button><button type="submit" className={styles.primaryButton} disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button></div>
          </form>
        </section>
      </div>
    );
  }

  function renderBulkDeleteDialog() {
    const rangeLabel = dateFrom || dateTo
      ? `${dateFrom ? formatDate(dateFrom) : 'the beginning'} to ${dateTo ? formatDate(dateTo) : 'today and later'}`
      : 'all time';
    const confirmed = bulkConfirmText.trim().toUpperCase() === 'DELETE';
    return (
      <div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget) setShowBulkDelete(false); }}>
        <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="bulk-dialog-title">
          <div className={styles.dialogHeader}><div><span className={styles.eyebrow}>DELETE IN BULK</span><h2 id="bulk-dialog-title">Delete expenses for {rangeLabel}</h2><p>This removes {rangeExpenses.length} {rangeExpenses.length === 1 ? 'expense' : 'expenses'} worth {formatMinorUnits(sumExpenses(rangeExpenses), currency)} from everyone’s balances.</p></div><button className={styles.closeButton} aria-label="Close dialog" onClick={() => setShowBulkDelete(false)}><X size={18} /></button></div>
          <form className={styles.form} onSubmit={event => { event.preventDefault(); if (confirmed) void bulkDeleteExpenses(); }}>
            <label className={styles.checkLine}><input type="checkbox" checked={bulkIncludePayments} onChange={event => setBulkIncludePayments(event.target.checked)} /><span>Also cancel payments recorded in this period, so no leftover balances remain.</span></label>
            <label>Type DELETE to confirm<input value={bulkConfirmText} onChange={event => setBulkConfirmText(event.target.value)} autoComplete="off" placeholder="DELETE" /></label>
            {errorMessage && <p className={styles.error} role="alert">{errorMessage}</p>}
            <div className={styles.dialogActions}><button type="button" className={styles.secondaryButton} onClick={() => setShowBulkDelete(false)}>Cancel</button><button type="submit" className={styles.dangerButton} disabled={busy || !confirmed || !rangeExpenses.length}>{busy ? 'Deleting…' : `Delete ${rangeExpenses.length} ${rangeExpenses.length === 1 ? 'expense' : 'expenses'}`}</button></div>
          </form>
        </section>
      </div>
    );
  }

  const navItems: { key: WorkspaceView; label: string; icon: typeof LayoutDashboard }[] = [
    { key: 'overview', label: 'Overview', icon: LayoutDashboard },
    { key: 'expenses', label: 'Expenses', icon: ReceiptText },
    { key: 'balances', label: 'Balances', icon: Wallet },
    { key: 'members', label: 'Members', icon: Users },
  ];

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link className={styles.brand} href="/" aria-label="FairShare home"><span className={styles.logoMark}><Command size={18} /></span><span>fairshare<span className={styles.brandDot}>.</span></span></Link>
        <div className={styles.orgArea}>
          <button className={styles.orgButton} aria-expanded={showOrgMenu} onClick={() => setShowOrgMenu(current => !current)}>
            <span className={styles.orgIcon}><CreditCard size={17} /></span><span className={styles.orgText}><strong>{activeOrganization?.name ?? 'Choose a space'}</strong><small>{activeOrganization?.type ?? 'Workspace'}</small></span><ChevronDown size={16} />
          </button>
          {showOrgMenu && <div className={styles.orgMenu}>{organizations.map(organization => <button key={organization.id} onClick={() => switchOrganization(organization.slug)}>{organization.name}{activeSlug === organization.slug && <Check size={15} />}</button>)}{managesASpace ? <p className={styles.menuNote}>To create another space, first transfer ownership of your space.</p> : <button className={styles.createOrgOption} onClick={() => { setShowOrgMenu(false); startCreateSpace(); }}><Plus size={15} />Create a space</button>}</div>}
        </div>
        <p className={styles.navLabel}>YOUR SPACE</p>
        <nav className={styles.nav} aria-label="Workspace navigation">{navItems.map(item => { const Icon = item.icon; return <button key={item.key} className={`${styles.navItem} ${view === item.key ? styles.navActive : ''}`} onClick={() => setView(item.key)}><Icon size={18} /><span>{item.label}</span>{item.key === 'expenses' && <small>{expenses.length}</small>}</button>; })}</nav>
        <div className={styles.sidebarBottom}><div className={styles.tipCard}><span>FAIR BY DESIGN</span><p>Every expense is split in whole minor units. No cents disappear.</p></div><button className={styles.userButton} onClick={() => void signOut()} disabled={busy}><span className={styles.avatar}>{initials(userName)}</span><span><strong>{userName}</strong><small>Sign out</small></span><LogOut size={16} /></button></div>
      </aside>

      <section className={styles.main}>
        <header className={styles.topbar}><div className={styles.breadcrumb}><span>{activeOrganization?.name}</span><span>/</span><strong>{navItems.find(item => item.key === view)?.label}</strong></div><div className={styles.topActions}><label className={styles.search}><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search expenses" aria-label="Search expenses" /></label><div className={styles.accountArea}><button className={styles.avatarButton} aria-expanded={showAccountMenu} aria-label="Account menu" onClick={() => setShowAccountMenu(current => !current)}>{initials(userName)}</button>{showAccountMenu && <div className={styles.accountMenu}><div className={styles.accountInfo}><strong>{userName}</strong><small>{currentRole ? roleLabels[currentRole] : 'Member'} · {activeOrganization?.name}</small></div><button onClick={() => { setShowAccountMenu(false); openProfile(); }}><Pencil size={15} />Edit profile</button>{platformAdmin && <button onClick={() => router.push('/admin')}><ShieldCheck size={15} />Admin console</button>}<button onClick={() => { setShowAccountMenu(false); setErrorMessage(''); setJoinCode(''); setJoinSecret(''); setShowJoin(true); }}><Plus size={15} />Join with invite code</button><p className={styles.accountSection}>YOUR SPACES</p>{organizations.map(organization => <button key={organization.id} onClick={() => { setShowAccountMenu(false); switchOrganization(organization.slug); }}><CreditCard size={15} /><span className={styles.accountSpaceName}>{organization.name}</span>{activeSlug === organization.slug && <Check size={15} />}</button>)}{managesASpace ? <p className={styles.menuNote}>To create another space, first transfer ownership of your space.</p> : <button onClick={() => { setShowAccountMenu(false); startCreateSpace(); }}><Plus size={15} />Create a space</button>}<button className={styles.signOutOption} disabled={busy} onClick={() => void signOut()}><LogOut size={15} />Sign out</button></div>}</div></div></header>
        <div className={styles.content}>
          <div className={styles.welcome}><div><span className={styles.eyebrow}>YOUR SHARED SPACE</span><h1>{view === 'overview' ? `Good to see you, ${userName.split(' ')[0]}` : navItems.find(item => item.key === view)?.label}</h1><p>{activeOrganization?.name} · {activeOrganization?.currency} · {members.length} active {members.length === 1 ? 'member' : 'members'}</p></div>{canWrite && view !== 'members' && <button className={`${styles.primaryButton} ${styles.headerAdd}`} onClick={openExpenseForm}><Plus size={17} />Add expense</button>}</div>

          {viaAdmin && <div className={styles.adminBanner} role="status"><span><ShieldCheck size={15} />Super admin access: you are managing <strong>{activeOrganization?.name}</strong> as an administrator. Every change is recorded.</span><Link href="/admin">Back to admin console</Link></div>}
          {errorMessage && !showExpenseForm && !showBulkDelete && <div className={styles.errorBanner} role="alert"><span>{errorMessage}</span><button aria-label="Dismiss error" onClick={() => setErrorMessage('')}><X size={16} /></button></div>}
          {ledger.error && <div className={styles.errorBanner} role="alert"><span>Balances cannot be calculated right now: {ledger.error}. Refresh the page; if it persists, review recent expense edits.</span></div>}
          {dataLoading && <div className={styles.loadingStrip}><LoaderCircle size={15} className={styles.spinner} />Refreshing shared data…</div>}
          {view === 'overview' && <section className={styles.summaryGrid} aria-label="Group totals">
            <article className={styles.summaryCard}><span>Total group spend</span><strong>{formatMinorUnits(totalSpent, currency)}</strong><small>{expenses.length} recorded {expenses.length === 1 ? 'expense' : 'expenses'}</small></article>
            <article className={styles.summaryCard}><span>Your balance</span><strong className={currentBalance && currentBalance.netMinor < 0 ? styles.negative : styles.positive}>{formatMinorUnits(currentBalance?.netMinor ?? 0, currency)}</strong><small>{currentBalance && currentBalance.netMinor > 0 ? 'You get back this much overall' : currentBalance && currentBalance.netMinor < 0 ? 'You owe this much overall' : 'All settled up'}</small></article>
            <article className={styles.summaryCard}><span>Left to settle</span><strong>{formatMinorUnits(leftToSettle, currency)}</strong><small>{suggestedTransfers.length === 0 ? 'Nobody owes anyone' : `${suggestedTransfers.length} ${suggestedTransfers.length === 1 ? 'payment' : 'payments'} needed`}</small></article>
          </section>}

          {view === 'overview' && <section className={`${styles.panel} ${styles.fullPanel}`}><div className={styles.panelHeader}><div><h2>Everyone’s balance</h2><p>Who gets money back and who owes, after all expenses and payments</p></div><Wallet size={17} className={styles.panelIcon} /></div>{renderBalanceRows()}</section>}

          {view === 'overview' && <div className={styles.overviewGrid}>
            <section className={styles.panel}><div className={styles.panelHeader}><div><h2>Who pays whom</h2><p>The fewest payments that settle everything</p></div><ArrowDownLeft size={17} className={styles.panelIcon} /></div>{renderSuggestedSettlements()}<button className={styles.textButton} onClick={() => setView('balances')}>Open balances <ArrowUpRight size={15} /></button></section>
            <section className={styles.panel}><div className={styles.panelHeader}><div><h2>Recent expenses</h2><p>Latest activity recorded in this space</p></div><button className={styles.textButton} onClick={() => setView('expenses')}>View all <ArrowUpRight size={15} /></button></div>{renderExpenseList(filteredExpenses.slice(0, 5))}</section>
          </div>}

          {view === 'expenses' && <section className={styles.panel}>
            <div className={styles.panelHeader}><div><h2>All expenses</h2><p>Every saved expense and its payer</p></div><div className={styles.headerTools}>{canWrite && <button className={styles.textButton} onClick={openBulk}><Camera size={15} />Add from photos</button>}<span className={styles.countPill}>{filteredExpenses.length} shown</span></div></div>
            <div className={styles.rangeBar}>
              <div className={styles.rangeChips} role="group" aria-label="Show expenses from">
                {([['all', 'All time'], ['month', 'This month'], ['last30', 'Last 30 days'], ['custom', 'Custom']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={rangePreset === key} className={`${styles.rangeChip} ${rangePreset === key ? styles.rangeChipActive : ''}`} onClick={() => selectRange(key)}>{label}</button>)}
              </div>
              {rangePreset === 'custom' && <div className={styles.rangeDates}>
                <input type="date" aria-label="From date" value={dateFrom} max={dateTo || undefined} onChange={event => setDateFrom(event.target.value)} />
                <span aria-hidden="true">to</span>
                <input type="date" aria-label="To date" value={dateTo} min={dateFrom || undefined} onChange={event => setDateTo(event.target.value)} />
              </div>}
            </div>
            {rangePreset !== 'all' && <p className={styles.filterSummary}>{rangeExpenses.length} {rangeExpenses.length === 1 ? 'expense' : 'expenses'} in this period · {formatMinorUnits(sumExpenses(rangeExpenses), currency)}</p>}
            {renderExpenseList(filteredExpenses)}
            {isOrganizationAdmin && rangeExpenses.length > 0 && <div className={styles.quietAction}><button type="button" onClick={() => { setErrorMessage(''); setBulkConfirmText(''); setShowBulkDelete(true); }}>Delete {rangePreset === 'all' ? 'all' : 'these'} {rangeExpenses.length} {rangeExpenses.length === 1 ? 'expense' : 'expenses'}…</button></div>}
          </section>}

          {view === 'balances' && <section className={styles.panel}><div className={styles.panelHeader}><div><h2>Member balances</h2><p>Paid minus fair share, adjusted for pending and confirmed transfers</p></div><Wallet size={17} className={styles.panelIcon} /></div>{renderBalanceRows()}<div className={styles.settlementSection}><h3>Suggested payments</h3>{renderSuggestedSettlements()}</div>{renderPendingSettlements()}{renderSettlementHistory()}{renderStatementPanel()}</section>}

          {view === 'members' && <section className={styles.panel}>
            <div className={styles.panelHeader}><div><h2>People in your space</h2><p>Admins can change roles and remove people. Nobody can join without an invite link.</p></div><span className={styles.countPill}>{members.length} active</span></div>
            {members.length ? <div className={styles.memberList}>{members.map(member => {
              const paid = sumExpenses(expenses.filter(expense => expense.payer_id === member.user_id));
              const isSelf = member.user_id === userId;
              const targetIsOwner = member.is_owner === true;
              // Nobody changes the owner (they transfer ownership themselves). Only the owner changes an admin's role;
              // helper admins manage members and viewers.
              const roleOptions: (MemberRole | 'owner')[] | null = targetIsOwner || !isOrganizationAdmin ? null
                : canChangeAdmins ? ['owner', 'admin', 'member', 'viewer']
                  : member.role === 'admin' ? null
                    : ['member', 'viewer'];
              const shareMode: 'beginning' | 'today' | 'custom' = customShareFor === member.user_id
                ? 'custom'
                : !member.share_from ? 'beginning'
                  : member.share_from === today() || (member.joined_at !== null && member.share_from === toDateInput(new Date(member.joined_at))) ? 'today' : 'custom';
              return <div className={styles.memberRow} key={member.user_id}>
                <span className={styles.avatar}>{initials(memberLabel(member.user_id))}</span>
                <div className={styles.balanceName}><strong>{memberLabel(member.user_id)}{isSelf ? ' (you)' : ''}</strong><small>Paid {formatMinorUnits(paid, currency)}</small>{isOrganizationAdmin && (member.phone || member.email) && <small className={styles.contactLine}>{[formatPhone(member.phone), member.email].filter(Boolean).join(' · ')}</small>}</div>
                {roleOptions
                  ? <select className={styles.roleSelect} aria-label={`Role for ${memberLabel(member.user_id)}`} value={member.role} disabled={busy} onChange={event => void changeMemberRole(member, event.target.value as MemberRole | 'owner')}>{roleOptions.map(role => <option key={role} value={role}>{role === 'owner' ? 'Owner' : roleLabels[role]}</option>)}</select>
                  : <span className={`${styles.roleChip} ${targetIsOwner || member.role === 'admin' ? styles.roleAdmin : ''}`}>{targetIsOwner ? 'Owner' : roleLabels[member.role]}</span>}
                {(isOrganizationAdmin && !isSelf && !targetIsOwner && (canChangeAdmins || member.role !== 'admin')) && <button className={styles.iconDanger} disabled={busy} aria-label={`Remove ${memberLabel(member.user_id)}`} onClick={() => void removeMember(member)}><UserMinus size={15} /></button>}
                {isSelf && !targetIsOwner && <button className={styles.leaveButton} disabled={busy} onClick={() => void removeMember(member)}>Leave</button>}
                <div className={styles.shareFromRow}>
                  <span>Shares group expenses {member.share_from ? `from ${formatDate(member.share_from)}` : 'from the beginning'}</span>
                  {isOrganizationAdmin && <div className={styles.shareModes} role="group" aria-label={`When ${memberLabel(member.user_id)} starts sharing`}>
                    <button type="button" aria-pressed={shareMode === 'beginning'} className={`${styles.rangeChip} ${shareMode === 'beginning' ? styles.rangeChipActive : ''}`} disabled={busy} onClick={() => { setCustomShareFor(''); void changeShareFrom(member, null); }}>From the beginning</button>
                    <button type="button" aria-pressed={shareMode === 'today'} className={`${styles.rangeChip} ${shareMode === 'today' ? styles.rangeChipActive : ''}`} disabled={busy} onClick={() => { setCustomShareFor(''); void changeShareFrom(member, today()); }}>From today onwards</button>
                    <button type="button" aria-pressed={shareMode === 'custom'} className={`${styles.rangeChip} ${shareMode === 'custom' ? styles.rangeChipActive : ''}`} disabled={busy} onClick={() => setCustomShareFor(member.user_id)}>Custom date</button>
                    {shareMode === 'custom' && <input type="date" aria-label={`Start date for ${memberLabel(member.user_id)}`} value={member.share_from ?? ''} disabled={busy} onChange={event => { if (event.target.value) void changeShareFrom(member, event.target.value); }} />}
                  </div>}
                </div>
              </div>;
            })}</div> : <div className={styles.empty}><Users size={24} /><strong>No active members</strong><span>Invite people with a link to join this space.</span></div>}
            {(currentRole || viaAdmin) && <div className={styles.codeCard}>
              <div><h3>Invite code</h3><p>Share this code with the people you want in this space. To join they also need the secret code, which only the owner and admins can see.</p></div>
              {inviteCode
                ? <div className={styles.codeRow}><code className={styles.codeValue}>{formatInviteCode(inviteCode)}</code><button type="button" className={styles.copyButton} aria-label="Copy invite code" onClick={() => void copyText(formatInviteCode(inviteCode), 'Invite code copied.')}><Copy size={16} /></button></div>
                : <p className={styles.hint}>{inviteCode === undefined ? 'Loading…' : 'Joining with a code is turned off.'}</p>}
              {currentRole === 'admin' && inviteCode && secretCode !== undefined && <div className={styles.secretRow}>
                <span className={styles.codeLabel}>Secret code (only you and other admins see this)</span>
                {secretCode
                  ? <div className={styles.codeRow}><code className={styles.codeValue}>{showSecret ? formatSecretCode(secretCode) : '•••••••••••'}</code><button type="button" className={styles.copyButton} aria-label={showSecret ? 'Hide secret code' : 'Show secret code'} onClick={() => setShowSecret(current => !current)}>{showSecret ? <EyeOff size={16} /> : <Eye size={16} />}</button><button type="button" className={styles.copyButton} aria-label="Copy secret code" onClick={() => void copyText(formatSecretCode(secretCode), 'Secret code copied.')}><Copy size={16} /></button></div>
                  : <p className={styles.hint}>No secret code: the invite code alone admits people.</p>}
                <button type="button" className={styles.linkButton} onClick={openProfile}>Change or reset the secret code</button>
              </div>}
              {currentRole === 'admin' && inviteCode !== undefined && <div className={styles.codeActions}>
                <button type="button" className={styles.linkButton} disabled={busy} onClick={() => void changeCode('code', true)}>{inviteCode ? 'Make a new code' : 'Turn on'}</button>
                {inviteCode && <button type="button" className={styles.linkButton} disabled={busy} onClick={() => void changeCode('code', false)}>Turn off</button>}
              </div>}
            </div>}
            {isOwner && <p className={styles.ownerNote}>You are the owner. To leave or create another space, first choose “Owner” for another member to transfer ownership. Each person can be admin of only one space.</p>}
            {currentRole === 'admin' && <div className={styles.invitePanel}>
              <div><h3>Invite people</h3><p>Create a link and share it on WhatsApp or anywhere else. Anyone who signs in with it joins with the role you pick. New members share group expenses from the day they join; change the date in their row above.</p></div>
              <div className={styles.inviteForm}>
                <label>Role<select value={inviteRole} onChange={event => setInviteRole(event.target.value === 'viewer' ? 'viewer' : 'member')}><option value="member">Member — can add expenses</option><option value="viewer">Viewer — read only</option></select></label>
                <button className={styles.primaryButton} type="button" disabled={inviteBusy} onClick={() => void createInviteLink()}>{inviteBusy ? 'Creating link…' : 'Create invite link'}</button>
              </div>
              {invitationLink && <div className={styles.inviteResult}>
                <label>{invitationOpen ? 'Invite link for anyone you share it with' : `Share this link with ${invitationEmail || 'the invited person'}`}<input readOnly value={invitationLink} onFocus={event => event.currentTarget.select()} /></label>
                <button className={styles.secondaryButton} onClick={() => void copyInvitationLink()}>Copy link</button>
                <div className={styles.shareRow} role="group" aria-label="Share invite link">
                  <button className={styles.shareButton} onClick={() => shareOn('whatsapp')}>WhatsApp</button>
                  <button className={styles.shareButton} onClick={() => shareOn('telegram')}>Telegram</button>
                  <button className={styles.shareButton} onClick={() => shareOn('x')}>X</button>
                  <button className={styles.shareButton} onClick={() => shareOn('email')}>Email</button>
                  {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && <button className={styles.shareButton} onClick={() => void shareNative()}>More…</button>}
                </div>
                <small>{invitationOpen ? 'Anyone with this link can join · expires in 7 days · creating a new link replaces this one' : 'Single use · expires in 7 days · recipient must sign up with this email'}</small>
              </div>}
              <details className={styles.emailInvite}>
                <summary>Invite a specific email instead</summary>
                <form className={styles.inviteForm} onSubmit={createInvitation}>
                  <label>Email address<input type="email" autoComplete="email" value={inviteEmail} onChange={event => setInviteEmail(event.target.value)} required placeholder="person@example.com" /></label>
                  <button className={styles.secondaryButton} type="submit" disabled={inviteBusy}>{inviteBusy ? 'Creating link…' : 'Create one-time link'}</button>
                </form>
              </details>
            </div>}
          </section>}

          {!expenses.length && !dataLoading && view !== 'members' && <div className={styles.emptyState}><ReceiptText size={23} /><strong>Your first shared expense is one click away.</strong><span>Add a real expense to see live totals and fair splits here.</span>{canWrite && <button className={styles.secondaryButton} onClick={openExpenseForm}><Plus size={15} />Add first expense</button>}</div>}
          <footer className={styles.footer}><span>© {new Date().getFullYear()} FairShare</span><span>Amounts and balances are based on saved records.</span></footer>
        </div>
      </section>
      {canWrite && !showExpenseForm && <button className={styles.fab} onClick={openExpenseForm} aria-label="Add expense"><Plus size={22} /><span>Add expense</span></button>}
      {showOrgForm && renderOrganizationDialog()}
      {showExpenseForm && renderExpenseDialog()}
      {showBulkDelete && renderBulkDeleteDialog()}
      {showProfile && renderProfileDialog()}
      {showBulk && renderBulkDialog()}
      {showJoin && renderJoinDialog()}
      {confirmRequest && (
        <div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget) answerConfirm(false); }}>
          <section className={`${styles.dialog} ${styles.dialogConfirm}`} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
            <div className={styles.dialogHeader}><div><h2 id="confirm-title">{confirmRequest.title}</h2><p id="confirm-message">{confirmRequest.message}</p></div></div>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.secondaryButton} onClick={() => answerConfirm(false)}>Cancel</button>
              <button type="button" autoFocus className={confirmRequest.danger ? styles.dangerButton : styles.primaryButton} onClick={() => answerConfirm(true)}>{confirmRequest.confirmLabel}</button>
            </div>
          </section>
        </div>
      )}
      {toast && <div className={`${styles.toast} ${toast.tone === 'error' ? styles.toastError : ''}`} role={toast.tone === 'error' ? 'alert' : 'status'}>{toast.tone === 'error' ? <X size={16} /> : <Check size={16} />}{toast.message}</div>}
    </main>
  );

  function renderBalanceRows() {
    if (!visibleBalances.length) {
      return <div className={styles.empty}><Wallet size={24} /><strong>No balances yet</strong><span>Add an expense to calculate everyone’s share.</span></div>;
    }
    return <div className={styles.balanceList}>{visibleBalances.map(balance => {
      const net = balance.netMinor;
      return <div className={styles.balanceRow} key={balance.memberId}>
        <span className={styles.avatar}>{initials(memberLabel(balance.memberId))}</span>
        <div className={styles.balanceName}>
          <strong>{memberLabel(balance.memberId)}{balance.memberId === userId ? ' (you)' : ''}</strong>
          <small>Paid {formatMinorUnits(balance.paidMinor, currency)} · Share {formatMinorUnits(balance.shareMinor, currency)}</small>
        </div>
        <div className={styles.balanceResult}>
          <strong className={net > 0 ? styles.positive : net < 0 ? styles.negative : ''}>{formatMinorUnits(Math.abs(net), currency)}</strong>
          <small>{net > 0 ? 'Gets back' : net < 0 ? 'Owes' : 'Settled up'}</small>
        </div>
      </div>;
    })}</div>;
  }

  function renderExpenseList(items: Expense[]) {
    if (!items.length) return <div className={styles.empty}><ReceiptText size={23} /><strong>No expenses found</strong><span>Try a different search or date range, or record a new shared cost.</span></div>;
    return <div className={styles.expenseList}>{items.map(expense => <article className={styles.expenseRow} key={expense.id}>
      <span className={styles.expenseIcon}><ReceiptText size={17} /></span>
      <div className={styles.expenseInfo}><strong>{expense.title}</strong><span>{categoryLabels[expense.category] ?? expense.category} · Paid by {memberLabel(expense.payer_id)} · {expense.split_scope === 'group' ? 'Whole group' : `Split ${expense.expense_splits.length} ${expense.expense_splits.length === 1 ? 'way' : 'ways'}`}</span></div>
      <time dateTime={expense.expense_date}>{formatDate(expense.expense_date)}</time>
      <strong className={styles.expenseAmount}>{formatMinorUnits(expense.amount_minor, expense.currency)}</strong>
      {canChangeExpense(expense) && <div className={styles.rowActions}>
        <button className={styles.editAction} disabled={busy} aria-label={`Edit ${expense.title}`} onClick={() => openEditForm(expense)}><Pencil size={14} /></button>
        <button className={styles.deleteAction} disabled={busy} aria-label={`Delete ${expense.title}`} onClick={() => void deleteExpense(expense)}><Trash2 size={14} /></button>
      </div>}
    </article>)}</div>;
  }

  function renderSuggestedSettlements() {
    if (!settlementRecords.length && !expenses.length) {
      return <div className={styles.emptyInline}><ReceiptText size={18} /><strong>No expenses to settle</strong><span>Suggestions appear after expenses are recorded.</span></div>;
    }
    if (!suggestedTransfers.length) {
      return <div className={styles.emptyInline}><Check size={18} /><strong>No one owes anyone</strong><span>Balances are reconciled for this space.</span></div>;
    }
    return <div className={styles.settlementList}>{suggestedTransfers.slice(0, view === 'balances' ? 50 : 5).map(transfer => <div className={styles.settlement} key={`${transfer.fromMemberId}-${transfer.toMemberId}`}>
      <div><strong>{memberLabel(transfer.fromMemberId)}</strong><span> pays </span><strong>{memberLabel(transfer.toMemberId)}</strong></div>
      <b>{formatMinorUnits(transfer.amountMinor, currency)}</b>
      {transfer.fromMemberId === userId
        ? <button className={styles.smallAction} disabled={busy} onClick={() => void recordTransfer(transfer.toMemberId, transfer.amountMinor)}>I paid</button>
        : <span className={styles.actionHint}>{transfer.toMemberId === userId ? 'Awaiting sender' : ''}</span>}
    </div>)}</div>;
  }

  function renderStatementPanel() {
    const timeZone = activeOrganization?.timezone ?? 'UTC';
    const months = recentMonthKeys(new Date(), timeZone, 12);
    const month = statementMonth && months.includes(statementMonth) ? statementMonth : months[0];
    const slug = activeOrganization?.slug ?? '';
    return <div className={styles.settlementSection}>
      <h3>Monthly statement</h3>
      <p className={styles.hint}>A PDF with the month&apos;s expenses, who paid what, who owes whom and the payments made.</p>
      <div className={styles.statementRow}>
        <select value={month} onChange={event => setStatementMonth(event.target.value)} aria-label="Statement month">{months.map(key => <option key={key} value={key}>{monthRange(key).label}</option>)}</select>
        <a className={styles.secondaryButton} href={`/api/organizations/${encodeURIComponent(slug)}/statements/pdf?month=${month}`} download>Download PDF</a>
      </div>
      {currentRole === 'admin' && statementSettings && <div className={styles.statementSettings}>
        <h4>Email it every month</h4>
        {!statementMeta.emailConfigured && <p className={styles.splitWarning} role="status">Email is not set up on the server yet, so statements cannot be sent. Add the SMTP settings first.</p>}
        <label className={styles.checkLine}><input type="checkbox" checked={statementSettings.enabled} onChange={event => setStatementSettings(current => current && { ...current, enabled: event.target.checked })} /><span>Send the statement automatically</span></label>
        <div className={styles.statementRow}>
          <label>On day<select value={statementSettings.day_of_month} onChange={event => setStatementSettings(current => current && { ...current, day_of_month: Number(event.target.value) })}>{Array.from({ length: 28 }, (_, index) => index + 1).map(day => <option key={day} value={day}>{day}</option>)}</select></label>
          <label>Send to<select value={statementSettings.recipients_mode} onChange={event => setStatementSettings(current => current && { ...current, recipients_mode: event.target.value as StatementSettings['recipients_mode'] })}><option value="admins">Owner and admins</option><option value="all_members">Every member</option><option value="extra_only">Only the extra emails below</option></select></label>
        </div>
        <label>Extra email addresses<textarea value={extraEmailsText} onChange={event => setExtraEmailsText(event.target.value)} rows={2} placeholder="accountant@example.com, friend@example.com" disabled={!statementMeta.isOwner} /><span className={styles.hint}>{statementMeta.isOwner ? 'Separate addresses with commas. Up to 20.' : 'Only the owner can change the extra addresses.'}</span></label>
        {statementSettings.last_sent_period && <p className={styles.hint}>Last sent: {monthRange(statementSettings.last_sent_period).label}.</p>}
        {statementSettings.last_error && <p className={styles.error} role="alert">The last automatic send failed: {statementSettings.last_error}</p>}
        {statementNote && <p className={statementNote.tone === 'error' ? styles.error : styles.scanOk} role="status">{statementNote.text}</p>}
        <div className={styles.statementRow}>
          <button type="button" className={styles.primaryButton} disabled={statementBusy} onClick={() => void saveStatementSettings()}>{statementBusy ? 'Saving…' : 'Save settings'}</button>
          <button type="button" className={styles.secondaryButton} disabled={statementBusy || !statementMeta.emailConfigured} onClick={() => void sendStatementNow(month)}>Send this month now</button>
        </div>
      </div>}
    </div>;
  }

  function renderSettlementHistory() {
    if (!closedSettlements.length) return null;
    return <div className={styles.settlementSection}><h3>Payment history</h3><div className={styles.settlementList}>{closedSettlements.map(settlement => <div className={styles.settlement} key={settlement.id}>
      <div><strong>{memberLabel(settlement.from_member_id)}</strong><span> paid </span><strong>{memberLabel(settlement.to_member_id)}</strong><small>{formatDate(settlement.created_at)}</small></div>
      <b>{formatMinorUnits(settlement.amount_minor, settlement.currency)}</b>
      <span className={settlement.status === 'confirmed' ? styles.statusConfirmed : styles.statusCancelled}>{settlement.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}</span>
    </div>)}</div></div>;
  }

  function renderPendingSettlements() {
    const pending = settlementRecords.filter(settlement => settlement.status === 'pending');
    if (!pending.length) return null;
    return <div className={styles.settlementSection}><h3>Pending transfers</h3><div className={styles.settlementList}>{pending.map(settlement => <div className={styles.settlement} key={settlement.id}>
      <div><strong>{memberLabel(settlement.from_member_id)}</strong><span> paid </span><strong>{memberLabel(settlement.to_member_id)}</strong><small>{formatDate(settlement.created_at, false)}</small></div>
      <b>{formatMinorUnits(settlement.amount_minor, settlement.currency)}</b>
      {settlement.to_member_id === userId
        ? <><button className={styles.smallAction} disabled={busy} onClick={() => void resolveTransfer(settlement, 'confirm')}>Confirm</button><button className={styles.cancelAction} disabled={busy} onClick={() => void resolveTransfer(settlement, 'cancel')}>Reject</button></>
        : settlement.from_member_id === userId
          ? <button className={styles.cancelAction} disabled={busy} onClick={() => void resolveTransfer(settlement, 'cancel')}>Cancel</button>
          : <span className={styles.actionHint}>Pending</span>}
    </div>)}</div></div>;
  }
}
