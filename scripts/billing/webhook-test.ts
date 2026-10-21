/**
 * Stripe webhook handling, tested with generated signatures.
 *
 *   npm run test:billing
 *
 * No real network and no real database. The signature is produced with
 * stripe.webhooks.generateTestHeaderString against a dummy secret, and the
 * database is a fake PostgREST on 127.0.0.1 that answers only
 * rpc/add_tailor_credits, with the same once-per-session rule as migration
 * 021 (true the first time a checkout session id arrives, false after that).
 *
 * The Supabase and Stripe env vars are deleted at startup, so a shell that
 * sourced .env.local still cannot make this test touch the live project.
 *
 * Covers the pure pieces (verify, grant extraction) for a valid delivery, a
 * bad signature, a tampered body, a stale timestamp, an unpaid session, an
 * async payment, an unrelated event type and bad metadata; and the real route
 * handler for 503 without Stripe env, 400 on a bad or missing signature, 200
 * credited on a valid delivery, 200 not credited on the duplicate delivery,
 * 200 ignored for an unrelated event, and 500 when the database fails.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import {
  applyCreditGrant,
  constructWebhookEvent,
  grantFromEvent,
} from "../../src/lib/billing-server";

// Nothing in this file may reach a real project, whatever the shell has.
for (const name of [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
]) {
  delete process.env[name];
}

const SECRET = "whsec_test_dummy_secret_for_generated_signatures";
const USER_ID = "11111111-1111-1111-1111-111111111111";

// Any key string works for the signing helpers; nothing is sent anywhere.
const stripe = new Stripe("sk_test_dummy", { appInfo: { name: "autopilot-webhook-test" } });

function checkoutEvent(
  overrides: Record<string, unknown> = {},
  type = "checkout.session.completed",
  sessionId = "cs_test_abc123",
): string {
  return JSON.stringify({
    id: "evt_test_1",
    object: "event",
    api_version: "2026-09-30.endive",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        payment_status: "paid",
        amount_total: 500,
        currency: "usd",
        payment_intent: "pi_test_123",
        client_reference_id: USER_ID,
        metadata: { user_id: USER_ID, pack: "tailor_20", credits: "20" },
        ...overrides,
      },
    },
  });
}

function sign(payload: string, secret = SECRET, timestamp?: number): string {
  return stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
}

// In-memory stand-in for the service-role client, for the pure-function
// tests: only rpc("add_tailor_credits") is used, once per session id.
function fakeService() {
  const sessions = new Set<string>();
  const balances = new Map<string, number>();
  return {
    sessions,
    balances,
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, "add_tailor_credits");
      const sessionId = args.p_session_id as string;
      const userId = args.p_user_id as string;
      const credits = args.p_credits as number;
      if (sessions.has(sessionId)) return { data: false, error: null };
      sessions.add(sessionId);
      balances.set(userId, (balances.get(userId) ?? 0) + credits);
      return { data: true, error: null };
    },
  };
}

// Fake PostgREST for the route tests. supabase-js posts an RPC to
// /rest/v1/rpc/<name> with the arguments as the JSON body and reads the JSON
// result back, so a scalar `true`/`false` body is exactly what the real
// add_tailor_credits returns. A session id of cs_test_dbdown answers 500 so
// the route's database-failure path can be exercised too.
type FakeDb = {
  url: string;
  requests: string[];
  sessions: Set<string>;
  close: () => Promise<void>;
};

function startFakeDb(): Promise<FakeDb> {
  const requests: string[] = [];
  const sessions = new Set<string>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      if (req.method === "POST" && req.url?.startsWith("/rest/v1/rpc/add_tailor_credits")) {
        const args = JSON.parse(body) as { p_session_id: string };
        if (args.p_session_id === "cs_test_dbdown") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "fake database is down", code: "XX000" }));
          return;
        }
        const first = !sessions.has(args.p_session_id);
        sessions.add(args.p_session_id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(first));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: `fake: unexpected ${req.method} ${req.url}` }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        sessions,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}`);
    throw err;
  }
}

function webhookRequest(body: string, signature?: string): Request {
  return new Request("http://localhost/api/billing/webhook", {
    method: "POST",
    headers: signature ? { "stripe-signature": signature } : {},
    body,
  });
}

async function main() {
  await test("valid signature: event verifies and yields a credit grant", () => {
    const payload = checkoutEvent();
    const event = constructWebhookEvent(stripe, payload, sign(payload), SECRET);
    assert.equal(event.type, "checkout.session.completed");
    const grant = grantFromEvent(event);
    assert.ok(grant, "expected a grant");
    assert.deepEqual(grant, {
      userId: USER_ID,
      sessionId: "cs_test_abc123",
      paymentIntentId: "pi_test_123",
      pack: "tailor_20",
      credits: 20,
      amountCents: 500,
      currency: "usd",
    });
  });

  await test("bad signature: wrong secret is rejected before anything is parsed", () => {
    const payload = checkoutEvent();
    assert.throws(
      () => constructWebhookEvent(stripe, payload, sign(payload, "whsec_someone_else"), SECRET),
      (err: unknown) => err instanceof Stripe.errors.StripeSignatureVerificationError,
    );
  });

  await test("tampered body: signature over the original body does not cover 999 credits", () => {
    const payload = checkoutEvent();
    const header = sign(payload);
    const tampered = payload.replace('"credits":"20"', '"credits":"999"');
    assert.notEqual(tampered, payload);
    assert.throws(
      () => constructWebhookEvent(stripe, tampered, header, SECRET),
      (err: unknown) => err instanceof Stripe.errors.StripeSignatureVerificationError,
    );
  });

  await test("stale timestamp: a replay from 10 minutes ago is outside the default tolerance", () => {
    const payload = checkoutEvent();
    const old = Math.floor(Date.now() / 1000) - 600;
    assert.throws(
      () => constructWebhookEvent(stripe, payload, sign(payload, SECRET, old), SECRET),
      (err: unknown) => err instanceof Stripe.errors.StripeSignatureVerificationError,
    );
  });

  await test("duplicate delivery: the same session credits once, second delivery returns false", async () => {
    const service = fakeService();
    const payload = checkoutEvent();
    const first = grantFromEvent(constructWebhookEvent(stripe, payload, sign(payload), SECRET));
    const second = grantFromEvent(constructWebhookEvent(stripe, payload, sign(payload), SECRET));
    assert.ok(first && second);
    assert.equal(await applyCreditGrant(service as never, first), true);
    assert.equal(await applyCreditGrant(service as never, second), false);
    assert.equal(service.balances.get(USER_ID), 20);
    assert.equal(service.sessions.size, 1);
  });

  await test("unpaid session: checkout.session.completed with payment_status unpaid grants nothing", () => {
    const payload = checkoutEvent({ payment_status: "unpaid" });
    const event = constructWebhookEvent(stripe, payload, sign(payload), SECRET);
    assert.equal(grantFromEvent(event), null);
  });

  await test("async payment: async_payment_succeeded with payment_status paid grants", () => {
    const payload = checkoutEvent({}, "checkout.session.async_payment_succeeded");
    const event = constructWebhookEvent(stripe, payload, sign(payload), SECRET);
    assert.equal(grantFromEvent(event)?.credits, 20);
  });

  await test("unrelated event type: payment_intent.succeeded is acknowledged and ignored", () => {
    const payload = checkoutEvent({}, "payment_intent.succeeded");
    const event = constructWebhookEvent(stripe, payload, sign(payload), SECRET);
    assert.equal(grantFromEvent(event), null);
  });

  await test("bad metadata: non-uuid user id or non-positive credits grants nothing", () => {
    for (const meta of [
      { user_id: "not-a-uuid", pack: "tailor_20", credits: "20" },
      { user_id: USER_ID, pack: "tailor_20", credits: "0" },
      { user_id: USER_ID, pack: "tailor_20", credits: "abc" },
      {},
    ]) {
      const payload = checkoutEvent({ metadata: meta, client_reference_id: null });
      const event = constructWebhookEvent(stripe, payload, sign(payload), SECRET);
      assert.equal(grantFromEvent(event), null, `metadata ${JSON.stringify(meta)}`);
    }
  });

  // ---- The real route handler --------------------------------------------

  const route = await import("../../src/app/api/billing/webhook/route");
  console.log(
    "(stack traces below the 400 and 500 route checks are captureError's console fallback; expected without a Sentry DSN)",
  );

  await test("route: 503 'Payments are not set up yet' when Stripe env is missing", async () => {
    const res = await route.POST(webhookRequest(checkoutEvent(), "t=1,v1=abc"));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "Payments are not set up yet" });
  });

  // Stripe env on, database still pointed nowhere: these paths stop before
  // the database is touched.
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;

  await test("route: 400 on a bad signature, and 400 without the header", async () => {
    const payload = checkoutEvent();
    const bad = await route.POST(webhookRequest(payload, sign(payload, "whsec_wrong")));
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "Invalid signature" });

    const missing = await route.POST(webhookRequest(payload));
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "Missing stripe-signature header" });
  });

  const db = await startFakeDb();
  process.env.NEXT_PUBLIC_SUPABASE_URL = db.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-dummy";
  try {
    await test("route: valid delivery credits (200), the same delivery again does not (200, credited false)", async () => {
      const payload = checkoutEvent({}, "checkout.session.completed", "cs_test_route_1");
      const first = await route.POST(webhookRequest(payload, sign(payload)));
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { received: true, credited: true });

      // Stripe retries with the same event body and a fresh signature.
      const second = await route.POST(webhookRequest(payload, sign(payload)));
      assert.equal(second.status, 200);
      assert.deepEqual(await second.json(), { received: true, credited: false });

      const rpcCalls = db.requests.filter((r) => r.includes("/rest/v1/rpc/add_tailor_credits"));
      assert.equal(rpcCalls.length, 2, "both deliveries reached the RPC");
      assert.equal(db.sessions.size, 1, "one ledger row for one checkout session");
      assert.equal(db.requests.length, 2, "nothing else was asked of the database");
    });

    await test("route: unrelated event is acknowledged without touching the database", async () => {
      const before = db.requests.length;
      const payload = checkoutEvent({}, "payment_intent.succeeded", "cs_test_route_2");
      const res = await route.POST(webhookRequest(payload, sign(payload)));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { received: true, credited: false });
      assert.equal(db.requests.length, before);
    });

    await test("route: database failure answers 500 so Stripe retries", async () => {
      const payload = checkoutEvent({}, "checkout.session.completed", "cs_test_dbdown");
      const res = await route.POST(webhookRequest(payload, sign(payload)));
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Unable to record the purchase" });
    });
  } finally {
    await db.close();
  }

  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
