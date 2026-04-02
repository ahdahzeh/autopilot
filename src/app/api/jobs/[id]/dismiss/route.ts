import { dismissJob } from "@/lib/notion";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const reason = body.reason;

    if (!["expired", "scam", "not_interested", "applied_elsewhere"].includes(reason)) {
      return Response.json({ error: "Invalid reason" }, { status: 400 });
    }

    await dismissJob(id, reason);
    return Response.json({ ok: true, id, reason });
  } catch (error) {
    console.error("Failed to dismiss job:", error);
    return Response.json({ error: "Failed to update Notion" }, { status: 500 });
  }
}
