import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const apiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!apiKey || !audienceId) {
    return NextResponse.json({ skipped: true, reason: "resend not configured" });
  }

  const { email: rawEmail, name: rawName } = await req.json().catch(() => ({}));
  // Public route: anything that passes lands in the Resend audience, so only
  // something shaped like an address (254 is the SMTP path limit).
  const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
  if (!email || email.length > 254 || !/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(email)) {
    return NextResponse.json({ error: "valid email required" }, { status: 400 });
  }
  // Signup sends the name it collected; a long one is cut rather than refused,
  // so the address still lands in the audience.
  const name = typeof rawName === "string" ? rawName.trim().slice(0, 100) : "";

  const [first_name, ...rest] = name.trim().split(/\s+/);
  const last_name = rest.join(" ");

  const res = await fetch(
    `https://api.resend.com/audiences/${audienceId}/contacts`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        first_name: first_name || undefined,
        last_name: last_name || undefined,
        unsubscribed: false,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return NextResponse.json({ error: "resend rejected", detail: body }, { status: res.status });
  }
  return NextResponse.json({ ok: true });
}
