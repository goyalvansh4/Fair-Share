import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type RouteContext = { params: Promise<{ slug: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { slug } = await context.params;
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

    type OrganizationRow = { id: string; owner_id?: string | null };
    const findOrganization = (columns: string) => supabase
      .from('organizations')
      .select(columns)
      .eq('slug', slug)
      .is('deleted_at', null)
      .maybeSingle();
    let organizationResult = await findOrganization('id,owner_id');
    // Databases without the owner migration still load; nobody is flagged as owner then.
    if (organizationResult.error?.code === '42703') organizationResult = await findOrganization('id');
    const organization = organizationResult.data as unknown as OrganizationRow | null;
    const organizationError = organizationResult.error;
    if (organizationError || !organization) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });

    type MembershipRow = { user_id: string; role: string; status: string; joined_at: string | null; share_from?: string | null };
    const baseColumns = 'user_id,role,status,joined_at';
    const loadMemberships = (columns: string) => supabase
      .from('organization_members')
      .select(columns)
      .eq('organization_id', organization.id)
      .in('status', ['active', 'removed'])
      .order('created_at');
    let result = await loadMemberships(`${baseColumns},share_from`);
    // Databases without the share_from migration still load; members then share everything.
    if (result.error?.code === '42703') result = await loadMemberships(baseColumns);
    const memberships = result.data as unknown as MembershipRow[] | null;
    const membershipError = result.error;
    if (membershipError) return NextResponse.json({ error: 'Unable to load organization members' }, { status: 400 });
    if (!memberships?.length) return NextResponse.json({ members: [] });

    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id,display_name,avatar_url')
      .in('id', memberships.map(member => member.user_id));
    if (profilesError) return NextResponse.json({ error: 'Unable to load member profiles' }, { status: 400 });

    // Admins also see each member's email and mobile number so people with unclear names can be identified.
    const contactsResult = await supabase.rpc('organization_member_contacts', { p_organization_id: organization.id });
    const contactById = new Map(
      ((contactsResult.error ? [] : contactsResult.data) as { member_id: string; email: string | null; phone: string | null }[] | null ?? [])
        .map(contact => [contact.member_id, contact]),
    );
    const profileById = new Map((profiles ?? []).map(profile => [profile.id, profile]));
    const members = memberships.map(member => ({
      user_id: member.user_id,
      role: member.role,
      status: member.status,
      is_owner: Boolean(organization.owner_id) && member.user_id === organization.owner_id,
      email: contactById.get(member.user_id)?.email ?? null,
      phone: contactById.get(member.user_id)?.phone ?? null,
      joined_at: member.joined_at,
      share_from: member.share_from ?? null,
      profile: profileById.get(member.user_id) ?? { id: member.user_id, display_name: '', avatar_url: null },
    }));
    return NextResponse.json({ members });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server configuration error' }, { status: 500 });
  }
}
