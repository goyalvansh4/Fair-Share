import { create } from 'zustand';
import { type Expense, type Member, type Settlement } from './workspace-types';

type Updater<T> = T | ((current: T) => T);

function resolve<T>(value: Updater<T>, current: T): T {
  return typeof value === 'function' ? (value as (current: T) => T)(current) : value;
}

type WorkspaceState = {
  members: Member[];
  expenses: Expense[];
  settlements: Settlement[];
  setMembers: (value: Updater<Member[]>) => void;
  setExpenses: (value: Updater<Expense[]>) => void;
  setSettlements: (value: Updater<Settlement[]>) => void;
  reset: () => void;
};

/**
 * Shared data of the space that is currently open. Living outside React state lets the realtime listener
 * (and any future screen) update it without prop drilling; components subscribe to just the slices they read.
 */
export const useWorkspaceStore = create<WorkspaceState>(set => ({
  members: [],
  expenses: [],
  settlements: [],
  setMembers: value => set(state => ({ members: resolve(value, state.members) })),
  setExpenses: value => set(state => ({ expenses: resolve(value, state.expenses) })),
  setSettlements: value => set(state => ({ settlements: resolve(value, state.settlements) })),
  reset: () => set({ members: [], expenses: [], settlements: [] }),
}));

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error('Refresh failed');
  return payload as T;
}

/** Re-reads members, expenses and payments of a space and stores them. Used by realtime events and polling. */
export async function refreshSpace(slug: string): Promise<void> {
  const base = `/api/organizations/${encodeURIComponent(slug)}`;
  const [members, expenses, settlements] = await Promise.all([
    getJson<{ members: Member[] }>(`${base}/members`),
    getJson<{ expenses: Expense[] }>(`${base}/expenses`),
    getJson<{ settlements: Settlement[] }>(`${base}/settlements`),
  ]);
  const state = useWorkspaceStore.getState();
  state.setMembers(members.members);
  state.setExpenses(expenses.expenses);
  state.setSettlements(settlements.settlements);
}
