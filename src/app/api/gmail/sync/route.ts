import { createClient, createServiceClient } from "@/lib/supabase/server";
import { syncUserGmail } from "@/lib/gmail-sync";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // Called by cron or manually
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();

  const { data: users } = await supabase
    .from("profiles")
    .select("id")
    .eq("gmail_connected", true)
    .eq("onboarded", true);

  if (!users?.length) return Response.json({ processed: 0 });

  const results = await Promise.all(
    users.map((u) => syncUserGmail(supabase, u.id).then((r) => ({ user_id: u.id, ...r }))),
  );

  return Response.json({ processed: users.length, results });
}

// Allow a single user to trigger their own sync
export async function GET() {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const result = await syncUserGmail(svc, user.id);
  return Response.json(result);
}
