/**
 * Email campaigns (src/lib/email-campaigns.ts) against a fake Supabase.
 *
 *   npm run test:emails
 *
 * No real network and no real database. The global fetch is replaced before
 * the campaigns load: the fake Supabase host answers PostgREST and the auth
 * admin user list in-process, api.resend.com is captured instead of sent, and
 * anything else throws. The Supabase and Resend env vars are overwritten at
 * startup, so a shell that sourced .env.local still cannot touch the live
 * project or send a real email.
 *
 * The fake PostgREST knows each table's columns from supabase/migrations and
 * answers an unknown column the way the real one does (400, code 42703). That
 * is the failure that kept every daily digest at "only 0 eligible matches"
 * from 2026-10-16 to 2026-11-04: the query asked for jobs.title, the column is
 * jobs.role, and the error was dropped. Engagement nudges asked for title and
 * url and went out with an empty job list.
 *
 * Covers: the digest sends with the user's top jobs, every select names real
 * columns, every skip logs its reason (too few matches, no address, throttled),
 * a failed jobs query is an error and not a silent skip, and the engagement
 * nudge carries the user's jobs and apply links, every send carries RFC 8058
 * List-Unsubscribe headers, and a throttle stamp that fails to save is an error.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

const FAKE_SUPABASE = "http://fake-supabase.test";
process.env.NEXT_PUBLIC_SUPABASE_URL = FAKE_SUPABASE;
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.RESEND_API_KEY = "re_test_not_a_real_key";
process.env.NEXT_PUBLIC_APP_URL = "https://autopilot.example.test";
delete process.env.NEXT_PUBLIC_SENTRY_DSN;

// ─── Schema from the migrations ─────────────────────────────────────────────

function columnsFromMigrations(): Record<string, Set<string>> {
  const dir = join(__dirname, "../../supabase/migrations");
  const tables: Record<string, Set<string>> = {};
  const add = (table: string, column: string) => (tables[table] ??= new Set()).add(column);
  const notColumns = new Set(["primary", "unique", "constraint", "foreign", "check", "exclude"]);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, file), "utf8").replace(/--.*$/gm, "");
    for (const m of sql.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      for (const line of m[2].split("\n")) {
        const col = line.trim().match(/^"?(\w+)"?\s+\w/)?.[1];
        if (col && !notColumns.has(col.toLowerCase())) add(m[1], col);
      }
    }
    for (const m of sql.matchAll(/alter table (?:only )?(?:public\.)?(\w+)([\s\S]*?);/gi)) {
      for (const c of m[2].matchAll(/add column (?:if not exists )?"?(\w+)"?/gi)) add(m[1], c[1]);
    }
  }
  return tables;
}

const SCHEMA = columnsFromMigrations();
assert.ok(SCHEMA.jobs?.has("role") && SCHEMA.jobs.has("score_reasoning"), "migration parser found jobs columns");
assert.ok(SCHEMA.profiles?.has("digest_email_last_at") && SCHEMA.profiles.has("hired_at"), "migration parser found profiles columns");

// ─── Fixtures ───────────────────────────────────────────────────────────────

const HOUR = 3600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const ALICE = "11111111-1111-4111-8111-111111111111"; // 6 good jobs: gets a digest
const BOB = "22222222-2222-4222-8222-222222222222"; // 2 good jobs: too few
const CARA = "33333333-3333-4333-8333-333333333333"; // no auth address
const DAN = "44444444-4444-4444-8444-444444444444"; // digest 2h ago: throttled
const ERIN = "55555555-5555-4555-8555-555555555555"; // her jobs query fails

const profile = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  display_name: `User ${id.slice(0, 1)}`,
  onboarded: true,
  hired_at: null,
  emails_opted_out: false,
  gmail_connected: true,
  unsubscribe_token: `unsub-${id.slice(0, 4)}`,
  digest_email_last_at: null,
  engagement_email_last_at: null,
  onboarding_reminder_count: 0,
  onboarding_reminder_last_at: null,
  created_at: iso(30 * 24 * HOUR),
  ...extra,
});

const PROFILES = [
  profile(ALICE),
  profile(BOB),
  profile(CARA),
  profile(DAN, { digest_email_last_at: iso(2 * HOUR) }),
  profile(ERIN),
];

const EMAILS: Record<string, string> = {
  [ALICE]: "alice@example.test",
  [BOB]: "bob@example.test",
  [DAN]: "dan@example.test",
  [ERIN]: "erin@example.test",
};

const job = (userId: string, n: number, extra: Record<string, unknown> = {}) => ({
  id: `${userId.slice(0, 8)}-job-${n}`,
  user_id: userId,
  role: `Role ${n} for ${userId.slice(0, 1)}`,
  company: `Company ${n}`,
  match_score: 10 - n,
  score_reasoning: `Fits because ${n}`,
  apply_link: `https://jobs.example.test/${userId.slice(0, 1)}/${n}`,
  source_url: `https://board.example.test/${n}`,
  created_at: iso(HOUR),
  ...extra,
});

const JOBS = [
  ...[1, 2, 3, 4, 5, 6].map((n) => job(ALICE, n)),
  job(BOB, 1),
  job(BOB, 2),
  job(BOB, 3, { apply_link: "" }), // no apply link: not digest-worthy
  job(BOB, 4, { score_reasoning: null }), // unscored: not digest-worthy
  ...[1, 2, 3].map((n) => job(DAN, n)),
  ...[1, 2, 3].map((n) => job(ERIN, n)),
];

// ─── Fake Supabase + captured Resend ────────────────────────────────────────

const schemaErrors: string[] = [];
const sent: { to: string; subject: string; text: string; headers?: Record<string, string> }[] = [];
const patched: { table: string; query: string; body: unknown }[] = [];
// A profile id whose PATCH answers 500, to check a failed throttle stamp is reported.
let failPatchFor: string | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** PostgREST select list: "id, title:role" -> [{ key: "id", col: "id" }, { key: "title", col: "role" }]. */
function parseSelect(select: string): { key: string; col: string }[] {
  return select.split(",").map((s) => s.trim()).filter(Boolean).map((item) => {
    const [a, b] = item.split(":");
    return b ? { key: a, col: b } : { key: a, col: a };
  });
}

function postgrest(method: string, url: URL, body: string | undefined): Response {
  const table = url.pathname.replace("/rest/v1/", "");
  const columns = SCHEMA[table];
  if (!columns) return json({ code: "42P01", message: `relation public.${table} does not exist` }, 404);

  if (method === "PATCH") {
    if (failPatchFor && url.search.includes(failPatchFor)) {
      return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
    }
    patched.push({ table, query: url.search, body: body ? JSON.parse(body) : null });
    return new Response(null, { status: 204 });
  }

  const fields = parseSelect(url.searchParams.get("select") ?? "*");
  for (const f of fields) {
    if (f.col !== "*" && !columns.has(f.col)) {
      schemaErrors.push(`${table}.${f.col}`);
      return json({ code: "42703", message: `column ${table}.${f.col} does not exist` }, 400);
    }
  }

  let rows: Record<string, unknown>[] = table === "profiles" ? PROFILES : table === "jobs" ? JOBS : [];
  for (const [key, raw] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    const [op, ...rest] = raw.split(".");
    const value = rest.join(".");
    rows = rows.filter((r) => {
      const v = r[key];
      if (op === "eq") return String(v) === value;
      if (op === "is") return value === "null" ? v == null : String(v) === value;
      if (op === "gte") return String(v) >= value;
      if (op === "not" && value === "is.null") return v != null;
      throw new Error(`fake PostgREST does not handle ${key}=${raw}`);
    });
  }

  if (table === "jobs" && url.searchParams.get("user_id") === `eq.${ERIN}`) {
    return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
  }

  const order = url.searchParams.get("order");
  if (order) {
    const [key, dir] = order.split(".");
    rows = [...rows].sort((a, b) => {
      const d = Number(a[key] ?? -Infinity) - Number(b[key] ?? -Infinity);
      return dir === "desc" ? -d : d;
    });
  }
  const limit = Number(url.searchParams.get("limit") ?? "0");
  if (limit) rows = rows.slice(0, limit);

  const out = rows.map((r) =>
    fields.some((f) => f.col === "*") ? r : Object.fromEntries(fields.map((f) => [f.key, r[f.col]])),
  );
  return json(out);
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : undefined;

  if (url.origin === FAKE_SUPABASE && url.pathname === "/auth/v1/admin/users") {
    const users = PROFILES.map((p) => ({ id: p.id, email: EMAILS[p.id] ?? "" }));
    return json({ users, aud: "authenticated" });
  }
  if (url.origin === FAKE_SUPABASE && url.pathname.startsWith("/rest/v1/")) return postgrest(method, url, body);
  if (url.host === "api.resend.com" && method === "POST") {
    const payload = JSON.parse(body ?? "{}");
    sent.push({ to: payload.to, subject: payload.subject, text: payload.text, headers: payload.headers });
    return json({ id: `test-${sent.length}` });
  }
  throw new Error(`test network guard: ${method} ${url.host}${url.pathname} is not faked`);
}) as typeof fetch;

// ─── Run ────────────────────────────────────────────────────────────────────

const logs: string[] = [];
for (const level of ["log", "info", "warn", "error"] as const) {
  console[level] = (...args: unknown[]) => { logs.push(format(...args)); };
}
// The campaigns' console output is captured above, so results go straight to stdout.
const out = (line: string) => process.stdout.write(`${line}\n`);

/** Same tag as userTag() in email-campaigns.ts. */
function userTagOf(id: string): string {
  return `user:${createHash("sha1").update(id).digest("hex").slice(0, 8)}`;
}

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    out(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    out(`FAIL ${name}\n     ${err instanceof Error ? err.message.split("\n").join("\n     ") : String(err)}`);
  }
}

async function main(): Promise<void> {
  const { processDailyDigest, processEngagementEmails } = await import("../../src/lib/email-campaigns");

  const digest = await processDailyDigest();
  const digestLogs = logs.splice(0);
  const digestSends = sent.splice(0);

  await check("daily digest: every select names a real column", () => {
    assert.deepEqual(schemaErrors, []);
  });
  await check("daily digest: Alice gets her top 5 matches", () => {
    const mail = digestSends.find((s) => s.to === EMAILS[ALICE]);
    assert.ok(mail, `no digest sent to Alice; sends: ${JSON.stringify(digestSends.map((s) => s.to))}`);
    for (const n of [1, 2, 3, 4, 5]) assert.ok(mail.text.includes(`Role ${n} for 1`), `digest lists Role ${n}`);
    assert.ok(!mail.text.includes("Role 6 for 1"), "digest stops at 5");
    assert.ok(patched.some((p) => p.table === "profiles" && p.query.includes(ALICE)), "throttle stamped");
  });
  await check("daily digest: carries one-click List-Unsubscribe headers", () => {
    const mail = digestSends.find((s) => s.to === EMAILS[ALICE]);
    assert.ok(mail, "no digest sent to Alice");
    assert.equal(
      mail.headers?.["List-Unsubscribe"],
      `<https://autopilot.example.test/api/emails/unsubscribe?token=unsub-${ALICE.slice(0, 4)}>`,
    );
    assert.equal(mail.headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  });
  await check("daily digest: only Alice is sent to", () => {
    assert.deepEqual(digestSends.map((s) => s.to), [EMAILS[ALICE]]);
    assert.equal(digest.sent, 1);
  });
  await check("daily digest: every skip logs its reason", () => {
    assert.equal(digest.skipped, 3, `skipped ${digest.skipped}`);
    const line = (id: string) => digestLogs.find((l) => l.includes("[daily-digest] skip") && l.includes(userTagOf(id)));
    assert.match(line(BOB) ?? "", /only 2 eligible matches/);
    assert.match(line(CARA) ?? "", /no email address/);
    assert.match(line(DAN) ?? "", /last digest \d+(\.\d)?h ago/);
  });
  await check("daily digest: a failed jobs query is an error, not a silent skip", () => {
    const err = digest.errors.find((e) => e.startsWith(userTagOf(ERIN)));
    assert.ok(err, `errors: ${JSON.stringify(digest.errors)}`);
    assert.match(err, /load jobs: canceling statement due to statement timeout/);
    assert.equal(digest.errors.length, 1);
    assert.equal(digest.eligible, 5);
  });

  schemaErrors.length = 0;
  patched.length = 0;
  failPatchFor = ALICE;
  const engagement = await processEngagementEmails();
  failPatchFor = null;
  const engagementSends = sent.splice(0);
  logs.splice(0);

  await check("engagement nudge: every select names a real column", () => {
    assert.deepEqual(schemaErrors, []);
  });
  await check("engagement nudge: carries the user's jobs and apply links", () => {
    const mail = engagementSends.find((s) => s.to === EMAILS[ALICE]);
    assert.ok(mail, `no nudge sent to Alice; sends: ${JSON.stringify(engagementSends.map((s) => s.to))}`);
    assert.ok(mail.text.includes("Role 1 for 1"), `nudge text names the top job:\n${mail.text}`);
    assert.ok(mail.text.includes("https://jobs.example.test/1/1"), "nudge links the apply link");
  });
  await check("engagement nudge: a failed jobs query sends nothing", () => {
    assert.ok(!engagementSends.some((s) => s.to === EMAILS[ERIN]), "Erin was sent an empty nudge");
    assert.ok(engagement.errors.some((e) => e.startsWith(userTagOf(ERIN))), `errors: ${JSON.stringify(engagement.errors)}`);
  });

  await check("engagement nudge: a failed throttle stamp is an error, the send still counts", () => {
    assert.ok(engagementSends.some((s) => s.to === EMAILS[ALICE]), "Alice was not sent a nudge");
    const err = engagement.errors.find((e) => e.startsWith(userTagOf(ALICE)));
    assert.ok(err, `errors: ${JSON.stringify(engagement.errors)}`);
    assert.match(err, /throttle stamp failed: canceling statement/);
    assert.equal(engagement.sent, engagementSends.length);
  });

  if (failures > 0) {
    out(`\n${failures} check${failures === 1 ? "" : "s"} failed`);
    process.exit(1);
  }
  out("\nall email campaign checks passed");
}

main().catch((err) => {
  out(`test crashed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
