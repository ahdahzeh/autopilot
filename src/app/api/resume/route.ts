import { createClient } from "@/lib/supabase/server";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const text = formData.get("text") as string | null;

  let resumeText = "";

  if (text?.trim()) {
    // Manual text input
    resumeText = text.trim();
  } else if (file) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const name = file.name.toLowerCase();

    if (name.endsWith(".pdf")) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfParseModule: any = await import("pdf-parse");
      const pdfParse = pdfParseModule.default ?? pdfParseModule;
      const result = await pdfParse(buffer);
      resumeText = result.text;
    } else if (name.endsWith(".doc") || name.endsWith(".docx")) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      resumeText = result.value;
    } else if (name.endsWith(".txt")) {
      resumeText = buffer.toString("utf-8");
    } else {
      return Response.json({ error: "Unsupported file type. Use PDF, DOC, DOCX, or TXT." }, { status: 400 });
    }
  } else {
    return Response.json({ error: "No file or text provided" }, { status: 400 });
  }

  // Clean up whitespace
  resumeText = resumeText.replace(/\s+/g, " ").trim();

  if (resumeText.length < 50) {
    return Response.json({ error: "Resume text too short. Please check your file." }, { status: 400 });
  }

  const { error } = await supabase
    .from("profiles")
    .update({ resume_text: resumeText })
    .eq("id", user.id);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ ok: true, length: resumeText.length });
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("profiles")
    .select("resume_text")
    .eq("id", user.id)
    .single();

  return Response.json({ resume_text: data?.resume_text || "" });
}
