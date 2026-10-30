import { NextResponse } from 'next/server';
import { isMonthKey, localMonthAndDay, monthRange, previousMonthKey } from '@/lib/statements/period';
import { buildStatementPdf } from '@/lib/statements/service';
import { createSupabaseServerClient } from '@/lib/supabase/server';

// Download the monthly statement as a PDF. Any member of the space can; row-level security limits what is read.
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const { data: organization } = await supabase
      .from('organizations').select('id,name,slug,currency,timezone').eq('slug', slug).is('deleted_at', null).maybeSingle();
    if (!organization) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });

    const requested = new URL(request.url).searchParams.get('month');
    if (requested && !isMonthKey(requested)) return NextResponse.json({ error: 'Choose a month like 2026-10.' }, { status: 422 });
    const month = monthRange(requested ?? previousMonthKey(localMonthAndDay(new Date(), organization.timezone).key));

    const { pdf } = await buildStatementPdf(supabase, organization, month);
    return new Response(new Blob([pdf as BlobPart], { type: 'application/pdf' }), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="fairshare-${organization.slug}-${month.key}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to build the statement' }, { status: 500 });
  }
}
