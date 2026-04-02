# Autopilot v3 — Self-Contained Multi-User App

## Goal

Transform Autopilot from a single-user Notion-backed dashboard into a self-contained multi-user web app where family and friends can sign up, set their job preferences, and get personalized job pipelines populated automatically.

## Architecture

### Current State
- Next.js 16 on Vercel
- Notion as database (read-only from dashboard)
- Local Python scrapers (Playwright) writing to Notion via system cron
- Single user (Adaze's data only)
- Claude API tailoring for resumes/cover letters
- Gmail tracker for response detection

### Target State
- Next.js 16 on Vercel (unchanged)
- **Supabase** as database + auth + row-level security
- **Railway** hosting Python scrapers as a microservice, triggered by Vercel cron
- Multi-user with per-user job preferences and isolated pipelines
- **No tailoring** (removed — requires API keys)
- Gmail tracker as **optional** per-user feature
- **Manual "Add Job"** button for user-sourced listings

### Tech Stack
- **Frontend:** Next.js 16, Tailwind CSS, Recharts (unchanged)
- **Database:** Supabase (Postgres)
- **Auth:** Supabase Auth (email+password + invite codes)
- **Scraping:** Python + Playwright on Railway
- **Cron:** Vercel cron triggers Railway scraper endpoint
- **Hosting:** Vercel (frontend) + Railway (scrapers)

---

## Data Model (Supabase / Postgres)

### `profiles` (extends Supabase auth.users)
| Column | Type | Description |
|--------|------|-------------|
| id | uuid (FK → auth.users) | Primary key |
| display_name | text | User's name |
| target_titles | text[] | e.g. ["Product Designer", "Senior Product Designer"] |
| target_locations | text[] | e.g. ["San Francisco", "Remote", "New York"] |
| salary_floor | integer | Minimum salary (e.g. 100000) |
| excluded_companies | text[] | Companies to skip |
| priority_industries | text[] | Industries to prioritize (fintech, healthtech, etc.) |
| priority_keywords | text[] | Keywords that signal high priority (e.g. "founding") |
| sources | text[] | Which scrapers to use: ["linkedin", "builtin", "hiringcafe", "bandana", "welcometothejungle"] |
| daily_job_limit | integer | Max new jobs per day (10, 20, or 30). Default: 20 |
| gmail_connected | boolean | Whether Gmail OAuth is active |
| is_admin | boolean | Can generate invite codes. Default: false |
| onboarded | boolean | Completed signup wizard. Default: false |
| created_at | timestamptz | |

### `jobs`
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| user_id | uuid (FK → profiles) | Owner. RLS enforced |
| company | text | |
| role | text | |
| location | text | |
| industry | text | |
| company_size | text | |
| source | text | Which scraper found it |
| source_url | text | Original listing URL |
| apply_link | text | Direct application link |
| salary_range | text | |
| match_score | integer | 1-10, computed by scoring logic |
| priority | text | High / Medium / Low |
| status | text | New, Reviewing, Applied, Interview, Offer |
| outcome | text | No Response, Rejected, Moved Forward |
| founding_role | boolean | |
| date_found | date | |
| date_applied | date | |
| response_date | date | |
| dismissed_at | timestamptz | Null if not dismissed |
| dismiss_reason | text | expired, scam, not_interested, applied_elsewhere |
| manually_added | boolean | Default: false |
| created_at | timestamptz | |
| dedup_hash | text | For deduplication (hash of company+role+location) |

### `invite_codes`
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| code | text | 6-char alphanumeric, unique |
| created_by | uuid (FK → profiles) | Who generated it |
| used_by | uuid (FK → profiles, nullable) | Who redeemed it |
| prefilled_profile | jsonb | Optional pre-filled preferences |
| expires_at | timestamptz | 7 days from creation |
| created_at | timestamptz | |

### Row-Level Security
All tables enforce `user_id = auth.uid()` on SELECT, INSERT, UPDATE, DELETE. Users can only see and modify their own data. Admin users can read invite_codes they created.

---

## Auth Flow

### Standard Signup (Email + Password)
1. User visits app → Sign Up page
2. Enters email + password
3. Supabase Auth creates account
4. Redirected to onboarding wizard
5. Wizard collects: name, target titles, locations, salary floor, sources, daily limit
6. Profile saved to `profiles` table
7. Redirected to dashboard (empty initially, jobs populate on next cron run)

### Invite Code Signup
1. Admin (Adaze) generates invite code from dashboard
2. Optionally pre-fills profile preferences (target titles, locations, etc.)
3. Shares code with family member
4. Family member visits app → enters invite code on signup
5. If pre-filled: preferences are loaded into wizard, user can edit or accept
6. If not pre-filled: standard wizard flow
7. Invite code marked as used

### Session Management
Supabase Auth handles JWT sessions. Server-side route handlers use `createServerClient` from `@supabase/ssr`. Client components use `createBrowserClient`.

---

## Scraper Architecture

### Deployment
Python scrapers deployed to **Railway** as a containerized service. Exposed as HTTP endpoints.

### Scraper Sources

#### Existing (port from Job Automator)
1. **LinkedIn** (`linkedin_scraper.py`) — public search pages, Playwright, 8 metro areas
2. **BuiltIn** (`builtin_scraper_v4.py`) — city subdomain searches, Playwright

#### New
3. **Hiring Cafe** — new Playwright scraper, pattern-matched to site structure
4. **Bandana** — new Playwright scraper
5. **Welcome to the Jungle** — new Playwright scraper, targets job listings pages

### Scraper API Contract
Vercel cron calls Railway with:
```json
POST /scrape
{
  "user_id": "uuid",
  "target_titles": ["Product Designer"],
  "target_locations": ["San Francisco", "Remote"],
  "salary_floor": 100000,
  "excluded_companies": ["Company X"],
  "sources": ["linkedin", "builtin", "hiringcafe"],
  "daily_job_limit": 20
}
```

Railway returns:
```json
{
  "jobs_found": 45,
  "jobs_after_filter": 22,
  "jobs_inserted": 18,
  "jobs_deduplicated": 4
}
```

### Cron Flow
```
Vercel cron fires daily (8 AM)
  → GET /api/cron (Next.js route)
  → Fetch all active users from Supabase (where onboarded = true)
  → For each user:
      → Count jobs inserted today for this user
      → If already at daily_job_limit, skip
      → POST to Railway /scrape with user's preferences
      → Railway scrapes, filters, scores, deduplicates
      → Railway inserts new jobs directly into Supabase
  → Return summary
```

### Filtering Logic (ported from settings_v5.py)
Per-user filtering based on their profile:
- **Title match:** job title must fuzzy-match one of `target_titles`
- **Location match:** job location must match one of `target_locations` (or "Remote")
- **Salary floor:** skip if salary is below `salary_floor`
- **Excluded companies:** skip if company is in `excluded_companies`
- **Deduplication:** hash of `company + role + location` checked against existing jobs for that user

### Scoring Logic (ported from daily_pipeline_v3.py)
- Industry match against `priority_industries` → +2
- Company size < 200 employees → +1
- Priority keyword match (e.g. "founding") → +2
- Remote option → +1
- Salary above floor by 30%+ → +1
- Score capped at 10

---

## Frontend Changes

### Removed
- `src/lib/notion.ts` — deleted entirely
- All Notion env vars (`NOTION_API_KEY`, `NOTION_DATA_SOURCE_ID`)
- Tailoring-related UI (if any)

### New Files
- `src/lib/supabase/client.ts` — browser Supabase client
- `src/lib/supabase/server.ts` — server-side Supabase client (cookies-based)
- `src/lib/supabase/middleware.ts` — auth middleware for protected routes
- `src/app/(auth)/login/page.tsx` — login page
- `src/app/(auth)/signup/page.tsx` — signup with optional invite code
- `src/app/(auth)/layout.tsx` — auth layout (no sidebar/header)
- `src/app/onboarding/page.tsx` — wizard for job preferences
- `src/app/settings/page.tsx` — edit preferences, manage invite codes, Gmail connect
- `src/components/add-job-modal.tsx` — manual job entry form
- `src/components/invite-code-generator.tsx` — admin generates codes

### Modified Files
- `src/app/api/jobs/route.ts` — Supabase queries instead of Notion
- `src/app/api/jobs/[id]/dismiss/route.ts` — Supabase update instead of Notion
- `src/app/api/cron/route.ts` — multi-user scraper orchestration
- `src/components/dashboard.tsx` — add "Add Job" button, user menu
- `src/lib/analytics.ts` — same computation logic, different data source
- `src/app/layout.tsx` — auth provider wrapper
- `middleware.ts` — protect dashboard routes, redirect unauthenticated users

### Unchanged
- `src/components/action-feed.tsx`
- `src/components/context-panel.tsx`
- `src/components/job-table.tsx`
- `src/components/kanban-board.tsx`
- `src/components/health-score.tsx`
- `src/components/mini-funnel.tsx`
- `src/components/chart-tabs.tsx`
- `src/components/dismiss-menu.tsx`
- `src/components/toast.tsx`
- `src/app/globals.css`
- All animations and design system

---

## Gmail Integration (Optional)

Available on the settings page. Users click "Connect Gmail" → OAuth2 flow → token stored in Supabase (encrypted). A separate cron job (or on-demand trigger) scans for job response emails and updates job statuses.

This is **not required** for the app to work. Jobs can be manually moved through statuses without Gmail.

---

## Manual Job Entry

"Add Job" button in the dashboard header opens a modal:
- Company name (required)
- Role (required)
- Location
- Apply link (URL)
- Salary range
- Source (free text, e.g. "Friend referral")

Job is inserted with `manually_added: true`, `status: New`, `date_found: today`.

---

## Environment Variables

### Vercel (Frontend)
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
RAILWAY_SCRAPER_URL=
CRON_SECRET=
```

### Railway (Scrapers)
```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

No Notion keys. No Claude API keys. No user-facing API keys.

---

## Onboarding Wizard Flow

1. **Welcome** — "Let's set up your job search"
2. **What roles?** — multi-select or free text for target titles
3. **Where?** — location picker (cities + "Remote" toggle)
4. **Salary floor?** — slider or input ($0 - $300K+)
5. **Sources?** — checkboxes: LinkedIn, BuiltIn, Hiring Cafe, Bandana, Welcome to the Jungle
6. **How many per day?** — radio: 10 / 20 / 30
7. **Any companies to exclude?** — optional, comma-separated
8. **Review & confirm** — summary of choices, "Start My Pipeline" button

If invite code had pre-filled data, steps are pre-populated but editable.

---

## Scope Boundaries

### In Scope
- Supabase schema + RLS policies
- Auth (email+password + invite codes)
- Onboarding wizard
- Scraper microservice on Railway (port existing + new sources)
- API route rewrites (Notion → Supabase)
- Manual job entry
- Settings/preferences page
- Daily job limit per user
- Admin invite code generation

### Out of Scope (future)
- Gmail integration (design is documented but not built in v3)
- Push notifications
- Mobile native app (Capacitor)
- AI tailoring / resume generation
- Team/org features
- Payment/billing
