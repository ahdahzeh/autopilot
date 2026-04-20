import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const apiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!apiKey || !audienceId) {
    return NextResponse.json({ skipped: true, reason: "resend not configured" });
  }

  const { email, name } = await req.json().catch(() => ({}));
  if (!email || typeof email !== "string") {
    return NextResponse.json({ error: "email required" }, { status: 400 });
  }

  const [first_name, ...rest] = (name || "").trim().split(/\s+/);
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
