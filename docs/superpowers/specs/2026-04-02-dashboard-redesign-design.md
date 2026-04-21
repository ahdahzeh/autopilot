# Autopilot Dashboard Redesign — Design Spec

## Problem

The current dashboard has three issues:
1. **Alert overload** — 214 alerts on 196 jobs. Almost every job is flagged, making alerts meaningless noise.
2. **Generic analytics layout** — stat cards + charts stacked vertically feels like a template, not a job search tool.
3. **No way to dismiss/archive jobs** — stale, expired, and scam jobs accumulate, polluting the pipeline and inflating alerts.

## Who uses this

The user and their family members. This is a **shared job search tool** — anyone should be able to open it, see what needs doing, and take action. Not a view-only dashboard.

## Design Decisions (validated via mockups)

| Decision | Outcome |
|----------|---------|
| Layout | **Split View** — 60/40 two-column layout. Left: action feed. Right: context panel. |
| Right panel | **Health Score + Stats + Funnel + Chart Tabs** — merged from explorations A, B, C. |
| Dismiss/archive | **Two-way Notion sync** — updates status in Notion directly. Single-click dismiss (default: "Not Interested") with long-press/right-click for reason menu (Expired, Scam, Not Interested, Already Applied Elsewhere). 5-second undo toast. |
| Data priority | "What should I do right now?" first, "Where do I stand?" always visible in right panel. |
| Full table | Behind a "View All" toggle at the bottom, not the default view. |

## Layout Structure

### Header
- "Autopilot" wordmark, left-aligned
- Refresh button, right-aligned
- Last synced timestamp

### Main Content — Split View

#### Left Column (60%) — Action Feed

**Section: Next Actions**
- Card-based list of jobs needing action, sorted by priority then match score
- Each card shows: Company, Role, Match Score, Days Since Found/Applied
- Each card has action buttons:
  - **"Apply"** (green) — for New/Reviewing jobs with apply links. Opens link in new tab.
  - **"Follow Up"** (blue) — for Applied jobs with no response after 7+ days.
  - **"Dismiss"** (gray) — single click archives with "Not Interested". Long-press opens reason menu.
- Action categories (shown as collapsible sections):
  1. **Top Picks** — High priority, not yet applied, sorted by match score desc
  2. **Follow Ups** — Applied 7+ days, no response
  3. **Review** — New jobs found today/yesterday
- "Show More" at bottom of each section (default shows 5 per section)
- Below all sections: **"View Full Pipeline"** link that expands the full sortable/filterable table

#### Right Column (40%) — Context Panel

Sticky, scrolls independently. Background: `#fafafa`.

**1. Pipeline Health Score**
- Large number (0–100), centered
- Color: green (#00FF66) if >= 60, red (#FF3B3B) if < 60
- Label: "On Track" / "Needs Attention" / "Critical"
- One-line diagnosis: e.g., "Apply more · Low response rate"
- Score formula: weighted combination of:
  - Application velocity (apps this week vs trailing avg) — 30%
  - Response rate — 25%
  - Pipeline freshness (% of jobs not stale) — 25%
  - Interview conversion rate — 20%

**2. Stats Grid (2x2)**
- Total Jobs | Applied
- Response Rate | Interviews
- Monospace numbers, muted labels

**3. Mini Funnel**
- Horizontal bars: Found → Applied → Interview → Offer
- Each bar shows count on the right

**4. Status Pills**
- Inline row: New (gray), Applied (green), Interview (blue), Rejected (red)
- Each pill shows count

**5. Chart Tabs**
- Toggle between: Velocity / Sources / Weekly Goal
- Small chart area (~100px height)
- Velocity: area chart of apps/week
- Sources: horizontal bar chart of source effectiveness
- Weekly Goal: progress bar toward weekly application target

### Full Pipeline Table (collapsed by default)

Expands when "View Full Pipeline" is clicked. Contains:
- All jobs with: Company, Role, Score, Priority, Status, Source, Salary, Date Applied, Apply Link
- Filters: status, source, priority
- Sort: match score, date found, date applied
- Bulk actions: select multiple → dismiss/archive
- Each row has individual dismiss button

## Dismiss/Archive Feature

### Flow
1. User clicks "Dismiss" on a card or table row
2. Job immediately disappears from view with a slide-out animation
3. Toast appears at bottom: "Dismissed [Company]. Undo (5s)"
4. After 5 seconds (or immediately on other action), API call updates Notion:
   - Sets Status to "Rejected"
   - Sets Outcome to the dismiss reason
   - Adds note: "Dismissed from Autopilot: [reason]"
5. If user clicks "Undo", job reappears and no Notion update is made

### Long-press / Right-click Menu
Options:
- **Expired** → Status: "Rejected", Outcome: "No Response", Note: "Dismissed: Expired"
- **Scam** → Status: "Rejected", Outcome: "Rejected", Note: "Dismissed: Scam"
- **Not Interested** (default for single click) → Status: "Rejected", Outcome: "Declined", Note: "Dismissed: Not Interested"
- **Already Applied Elsewhere** → Status: "Applied", Note: "Applied through different channel"

### API Route: `POST /api/jobs/[id]/dismiss`
- Body: `{ reason: "expired" | "scam" | "not_interested" | "applied_elsewhere" }`
- Updates Notion page via SDK (pages.update with appropriate status/outcome/note)
- Returns updated job object

## Pipeline Health Score Calculation

```
score = (velocityScore * 0.30) + (responseScore * 0.25) + (freshnessScore * 0.25) + (conversionScore * 0.20)
```

- **velocityScore**: `min(100, (appsThisWeek / weeklyTarget) * 100)` where weeklyTarget defaults to 10
- **responseScore**: `min(100, responseRate * 5)` (so 20% response = 100)
- **freshnessScore**: `((totalJobs - staleJobs) / totalJobs) * 100`
- **conversionScore**: `min(100, (interviews / applied) * 500)` (so 20% conversion = 100)

Labels:
- 80–100: "On Track" (green)
- 60–79: "Keep Going" (green)
- 40–59: "Needs Attention" (red)
- 0–39: "Critical" (red)

## Mobile Behavior

On screens < 768px, the split view collapses to a single column:
- Health Score + Stats appear as a compact header strip
- Action Feed takes full width below
- Chart tabs and funnel accessible via a "Stats" toggle
- Full table remains behind "View All"

## Tech Stack (unchanged)

- Next.js 16 (App Router)
- Tailwind CSS
- Recharts (for chart tabs)
- @notionhq/client v5 (dataSources.query + pages.update for dismiss)
- Vercel Cron (for reminders)
- date-fns

## Files to Modify/Create

| File | Action |
|------|--------|
| `src/app/page.tsx` | Update to use new Dashboard component |
| `src/components/dashboard.tsx` | Rewrite — split view layout |
| `src/components/action-feed.tsx` | New — left column action cards |
| `src/components/context-panel.tsx` | New — right column with health score, stats, funnel, chart tabs |
| `src/components/health-score.tsx` | New — pipeline health score component |
| `src/components/mini-funnel.tsx` | New — horizontal bar funnel |
| `src/components/chart-tabs.tsx` | New — toggleable velocity/sources/weekly goal charts |
| `src/components/job-table.tsx` | Update — add dismiss buttons, bulk actions, collapsed by default |
| `src/components/dismiss-menu.tsx` | New — dismiss reason popover |
| `src/components/toast.tsx` | New — undo toast |
| `src/lib/analytics.ts` | Update — add health score calculation, weekly goal tracking |
| `src/lib/notion.ts` | Update — add dismissJob function (pages.update) |
| `src/app/api/jobs/[id]/dismiss/route.ts` | New — POST endpoint for dismiss |
| `src/components/stat-card.tsx` | Keep as-is, used in context panel |
| `src/components/charts.tsx` | Refactor — extract into chart-tabs.tsx |
| `src/components/alerts-panel.tsx` | Delete — replaced by action feed |
