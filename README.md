# FairShare

FairShare is a multi-tenant expense-sharing app for trips, homes, events, and groups. Members can record expenses, choose participants, review integer-accurate balances, invite people with expiring links, and record/confirm transfers.

## Current functionality

- Email/password sign-up and sign-in with Supabase Auth; email confirmation is supported.
- Password reset flow through Supabase Auth.
- Request-scoped Supabase SSR sessions, server-rendered page guards, and authenticated API handlers.
- Create and switch between tenant organizations.
- Invite people with a shareable link (WhatsApp, Telegram, X, email or the device share sheet) that adds them as a member or viewer, or with a one-use, seven-day email-bound link. Delivery is manual; no paid email provider is required.
- Save expenses atomically through a PostgreSQL function, split equally, by shares, or with exact per-person amounts.
- Delete an expense (author or admin only); viewers get a read-only UI.
- Payment history shows confirmed and cancelled transfers.
- Home shows everyone's balance (who gets money back, who owes) and the fewest payments that settle the group.
- Edit expenses (author or admin) with conflict detection; filter by date range; admins can bulk-delete expenses for a date range.
- Each space has its own admins. Admins can promote, demote or remove members; people can leave. The last admin cannot be removed or demoted, and members must be settled up first.
- The expense form remembers the last payer, participants, category and split mode per space in the browser, with Select all / Clear.
- Calculate totals, balances, and suggested settlements from persisted records.
- Record, confirm, or cancel transfers through audited database functions.
- Row-level security policies scope reads and writes to organization membership.
- FairShare-branded favicon and responsive, keyboard-accessible UI.

Email delivery/SMTP, automatic recurring expenses, receipt OCR, exports, and platform-admin tooling are not implemented. Do not treat this application as a payment processor: settlement records track user-reported payments and do not move money.

## Architecture

The app is a modular monolith: Next.js App Router UI and route handlers, Supabase Auth/PostgreSQL as the source of truth, and a small pure TypeScript expense engine. PostgreSQL RLS is the tenant boundary; API handlers also authenticate requests and validate input. Financial writes spanning multiple rows use database transactions/RPCs. Money is represented as integer minor units, never floats.

Server-side Supabase clients are created per request so cookie/session state cannot leak across users or Cloudflare Worker isolates. Do not make user-, session-, or tenant-scoped clients global singletons. Only immutable, stateless helpers/configuration may be shared.

For hosting, use `@opennextjs/cloudflare` to run the existing Next.js app on Cloudflare Workers, while keeping Supabase as the database and auth provider. Moving to Cloudflare D1 would require replacing the current PostgreSQL schema, RLS policies, auth, and transactional functions.

## Requirements and local setup

- Node.js 20.9+ (Node.js LTS recommended)
- npm
- A Supabase project

Create `.env.local` from `.env.example` and set:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
```

Never put a Supabase service-role key, database password, or Cloudflare API token in browser-visible variables or source control. The checked-in `.gitignore` excludes `.env*` except `.env.example`.

Install and run:

```bash
npm install
npm run dev
```

Open http://localhost:3000. Configure the Supabase Auth site URL and redirect allowlist to include `http://localhost:3000` and `http://localhost:3000/auth/callback`. To enable Google sign-in, enable Google under Supabase Authentication providers and add the Google OAuth client ID and secret; use the Supabase-provided callback URL as the authorized redirect URI in Google Cloud Console. Signup may require email confirmation depending on the project’s Auth settings.

## Database

Review and apply migrations in order to a development Supabase project:

1. `supabase/migrations/0001_foundation.sql` — profiles, organizations, roles, and tenant RLS.
2. `supabase/migrations/0002_expenses_and_audit.sql` — expenses, allocations, settlements, and audit log.
3. `supabase/migrations/0003_transactional_expense_rpc.sql` — atomic expense creation.
4. `supabase/migrations/0004_settlement_workflows.sql` — settlement transitions, audit events, and immutable client-side financial records.
5. `supabase/migrations/0005_organization_invitations.sql` — hashed, expiring invitations and atomic acceptance.
6. `supabase/migrations/0006_daily_health_check.sql` — data-free endpoint for the optional scheduled availability ping.
7. `supabase/migrations/0007_void_expense.sql` — audited soft-delete of an expense by its author or an admin.
8. `supabase/migrations/0008_oauth_display_name.sql` — uses the Google profile name for new OAuth users instead of the email prefix.
9. `supabase/migrations/0009_open_invite_links.sql` — shareable open invite links (one live link per role) alongside email invitations.
10. `supabase/migrations/0010_member_admin_and_expense_management.sql` — member roles, removal/leave, expense editing with conflict detection, and admin bulk delete by date range.
11. `supabase/migrations/0011_group_expenses.sql` — whole-group expenses that are split by the database and automatically include members who join later.
12. `supabase/migrations/0012_member_share_from.sql` — per-member start date for whole-group expenses (new joiners start the day they join; admins can change it).
13. `0013`-`0021`: super admin and statements groundwork, single-admin rule, realtime, owner role, profile contacts, receipt scan limits, invite and secret codes, security hardening, and the fixes from the independent review (see the comments at the top of each file).

With the Supabase CLI installed and the project linked:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

The first trusted operator must provision any platform-admin accounts directly through a controlled database workflow. No public self-promotion path exists.

## Quality checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Unit tests cover equal/weighted splits, ledger reconciliation, settlement adjustments, currency precision, and invitation tokens. For production confidence, also run database integration tests with at least two users in separate organizations, verifying that cross-tenant reads/writes are denied and invite/settlement state transitions are atomic.

## Free-tier and Cloudflare notes

Cloudflare Workers Free has a daily request/CPU quota; verify current limits in Cloudflare’s [Workers pricing documentation](https://developers.cloudflare.com/workers/platform/pricing/). Supabase Free projects with low database activity over a week may be paused; Supabase says a few database requests on each day typically help avoid inactivity pausing, but no scheduled ping can guarantee availability or resume a project that has already paused. See [Supabase project pausing](https://supabase.com/docs/guides/platform/paused-projects).

A minimal daily Worker Cron Trigger can perform one low-cost read-only database health query and log failures, subject to provider quotas and terms. It must not be described as uptime insurance. Production deployment still requires Cloudflare account/domain access, Supabase migration approval, configured redirect URLs, and secret configuration via provider dashboards/secret commands.

## Cloudflare Workers

The Worker uses the OpenNext adapter and a thin custom entry point that delegates web requests to OpenNext and runs the once-daily UTC health check. No R2 bucket or paid AI/email service is required for the current feature set.

For local Worker-runtime preview:

```powershell
Copy-Item .dev.vars.example .dev.vars
# Fill the two Supabase public values in .dev.vars
npm run cf:preview
```

The publishable Supabase URL/key are public configuration and must be present at **build time** so Next.js can include them in the browser client bundle, and at **Worker runtime** so server auth and the cron function can read them. Never use a service-role key. After applying all migrations and configuring Supabase Auth redirect allowlists:

```powershell
npx wrangler login
npx wrangler secret put NEXT_PUBLIC_SUPABASE_URL
npx wrangler secret put NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
npm run cf:deploy
```

For automated builds, provide the two publishable values as protected build variables; configure the same values for the Worker runtime. Add the deployed `https://<worker-domain>/auth/callback` to the Supabase Auth redirect allowlist. Check Cloudflare deployment status and test sign-up, tenant isolation, expense creation, invitations, and settlements against staging before directing real users to production.

## Security model

Money is only written through audited, transactional database functions. After migration `0020`, signed-in users cannot insert, update or delete expenses, splits, payments or memberships directly, and internal helper functions are not callable from the browser. Spaces have one owner (always an admin), optional helper admins, members and viewers; the rules are enforced in the database (`0016`, `0021`), not only in the UI. One person can be admin of only one space.

**Joining a space:** with an invite link, or with the space's invite code plus its secret code. The invite code is visible to every member of the space; the secret code is visible and editable (reset or custom) only by the real owner and admins, never by a super admin. Wrong guesses are limited per person.

**Super admin (`/admin`):** platform admins are created only by an operator running SQL (below). Opening `/admin` asks for `ADMIN_CONSOLE_PASSWORD`, checked on the server; success stores a 30-minute elevation in the database, and only the server (service role) can create it, so a stolen normal session gains nothing. Five wrong passwords lock the console (5 minutes, doubling). While unlocked, a super admin can read, edit, archive, delete and restore spaces, but cannot see secret codes or invite people into a space. Deleting is a soft delete.

Create a platform admin (run in the Supabase SQL editor, replacing the email):

```sql
insert into public.platform_admins (user_id, reason)
select id, 'owner' from auth.users where email = 'you@example.com';
```

Server secrets (set them with `npx wrangler secret put NAME` for Cloudflare, and in `.env.local` for development): `ADMIN_CONSOLE_PASSWORD`, `SUPABASE_SERVICE_ROLE_KEY` (used only by the admin unlock routes), `GROQ_API_KEY` (free) or `ANTHROPIC_API_KEY` (receipt and photo scanning; Anthropic is used when both are set, `GROQ_VISION_MODEL` optionally overrides the Groq model). None of them may ever be exposed to the browser.

Photo scanning sends the image to Groq or the Anthropic API to read it; images are not stored. Groq's free models can misread handwriting and blurry photos more often, so always check the suggested values before saving. Each person can scan at most 20 times per hour.

## Production checklist

1. **Database:** `npx supabase db push` (all migrations through `0022`).
2. **Supabase Auth:** set the Site URL to your production URL and add `https://<your-domain>/auth/callback` to the redirect allow-list (Google sign-in uses the same callback). Realtime must be enabled for the project; migration `0015` adds the tables to it.
3. **First super admin:** run the SQL under "Security model" once.
4. **Secrets (Cloudflare):** `npx wrangler secret put NAME` for each of `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_CONSOLE_PASSWORD`, `GROQ_API_KEY` or `ANTHROPIC_API_KEY`, `CRON_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`. The two `NEXT_PUBLIC_` values must also be present at build time.
5. **Try it on the real Workers runtime first:** copy `.dev.vars.example` to `.dev.vars`, fill it in, run `npm run cf:preview`, then check sign-in, an expense, a photo scan, `/admin`, and "Send this month now" on the Balances tab. This is what proves SMTP works on Workers.
6. **Deploy:** `npx wrangler login`, then `npm run cf:deploy`. The daily trigger (05:00 UTC) sends statements that are due and runs the health check.

Monthly statement emails use `worker-mailer` over SMTP (ports 465 or 587; Cloudflare Workers cannot use port 25). It uses Workers' own TCP sockets; nodemailer does not work on Workers because it connects to a resolved IP, which Workers refuse. If SMTP does not work on Workers for your provider, replace `src/lib/statements/mailer.ts` with an HTTP email API; nothing else depends on it.
