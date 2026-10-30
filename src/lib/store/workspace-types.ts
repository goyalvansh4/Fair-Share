export type MemberRole = 'admin' | 'member' | 'viewer';

export type Member = {
  user_id: string;
  role: MemberRole;
  status: 'active' | 'removed';
  /** True for the single owner of the space (the owner is always an admin). */
  is_owner?: boolean;
  /** Contact details, returned to admins of the space only. */
  email?: string | null;
  phone?: string | null;
  joined_at: string | null;
  /** Whole-group expenses dated before this day are not shared with the member; null = from the beginning. */
  share_from?: string | null;
  profile: { id: string; display_name: string; avatar_url: string | null };
};

export type Expense = {
  id: string;
  title: string;
  description: string | null;
  amount_minor: number;
  currency: string;
  expense_date: string;
  payer_id: string;
  category: string;
  split_method: string;
  split_scope?: 'selected' | 'group';
  created_by: string;
  created_at: string;
  updated_at: string;
  expense_splits: { member_id: string; amount_minor: number }[];
};

export type Settlement = {
  id: string;
  from_member_id: string;
  to_member_id: string;
  amount_minor: number;
  currency: string;
  status: 'pending' | 'confirmed' | 'cancelled';
  note: string | null;
  created_at: string;
};
