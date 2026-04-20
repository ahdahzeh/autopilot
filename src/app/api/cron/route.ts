import { createServiceClient } from "@/lib/supabase/server";
import { scrapeForUser } from "@/lib/scrape";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();

  const { data: users, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("onboarded", true);

  if (error || !users) {
    return Response.json({ error: "Failed to fetch users" }, { status: 500 });
  }

  const results = [];
  for (const user of users) {
    results.push(await scrapeForUser(user.id));
  }

  // Gmail sync — runs after scraping
  try {
    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/gmail/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
  } catch (err) {
    console.error("Gmail sync failed:", err);
  }

  return Response.json({
    processed: users.length,
    results,
    timestamp: new Date().toISOString(),
  });
}
