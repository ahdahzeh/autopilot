import { createHash } from "node:crypto";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText, type LanguageModel } from "ai";
import { createClient } from "@/lib/supabase/server";
import { captureError } from "@/lib/sentry";
import {
  BLOCK_PROMPTS,
  MODELS,
  TAILOR_BLOCKS,
  type ModelChoice,
  type TailorBlock,
  type Tone,
} from "@/lib/tailor-prompts";
import {
  keywordsSchema,
  matchSchema,
  strategySchema,
} from "@/lib/tailor-schemas";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DAILY_LIMIT = 40;

// Blocks that go through generateObject (auto-retry, schema-validated).
// Everything else stays on generateText because the output is prose-shaped
// (cover letter paragraphs, interview Q/A, referral copy) and a strict
// schema would only fight the model.
const STRUCTURED_SCHEMAS = {
  match: matchSchema,
  keywords: keywordsSchema,
  strategy: strategySchema,
} as const;

type Body = {
  jobDescription: string;
  role: string;
  company: string;
  jobId?: string;
  blocks?: TailorBlock[];
};

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as Body;
  if (!body.jobDescription || body.jobDescription.trim().length < 50) {
    return Response.json({ error: "Job description is too short." }, { status: 400 });
  }

  const requested = (body.blocks && body.blocks.length
    ? body.blocks.filter((b) => (TAILOR_BLOCKS as readonly string[]).includes(b))
    : TAILOR_BLOCKS.slice()) as TailorBlock[];
  if (requested.length === 0) {
    return Response.json({ error: "No valid blocks requested." }, { status: 400 });
  }

  const rateOk = await checkAndBumpRateLimit(supabase, user.id);
  if (!rateOk) {
    return Response.json(
      {
        error: `Daily tailoring limit reached (${DAILY_LIMIT}/day). Resets at midnight UTC. Add your own Anthropic API key in Settings to remove the cap.`,
      },
      { status: 429 },
    );
  }

  // Pull resume_text + resume_summary together. The summary is generated at
  // upload time for resumes >6000 chars; if it exists we feed it to the
  // model instead of an arbitrary slice of the raw text.
  const { data: baseProfile, error: profileErr } = await supabase
    .from("profiles")
    .select("resume_text, resume_summary")
    .eq("id", user.id)
    .single();

  if (profileErr || !baseProfile) {
    captureError(profileErr, { route: "tailor", stage: "profile_load" });
    return Response.json(
      { error: `Could not load your profile: ${profileErr?.message ?? "unknown error"}` },
      { status: 500 },
    );
  }

  const rawResume = (baseProfile.resume_text as string | null) ?? "";
  const summarized = (baseProfile.resume_summary as string | null) ?? "";
  if (!rawResume || rawResume.length < 200) {
    return Response.json(
      { error: "Upload your resume in onboarding before tailoring." },
      { status: 400 },
    );
  }

  // Use the summary when available so prompts get the highlights instead of
  // a hard slice that might cut a relevant role in half.
  const resumeForPrompt = summarized && summarized.length > 200 ? summarized : rawResume.slice(0, 8000);
  const resumeHash = sha256(rawResume);

  let userKey: string | undefined;
  try {
    const { data: keyRow } = await supabase
      .from("profiles")
      .select("anthropic_api_key")
      .eq("id", user.id)
      .maybeSingle();
    userKey = (keyRow?.anthropic_api_key as string | null | undefined)?.trim() || undefined;
  } catch (e) {
    captureError(e, { route: "tailor", stage: "load_user_key", note: "column may be missing" });
  }

  const { data: prefs } = await supabase
    .from("profiles")
    .select("tailoring_tone, tailoring_model")
    .eq("id", user.id)
    .maybeSingle();

  const sharedKey = process.env.ANTHROPIC_API_KEY?.trim();
  const tone: Tone = (prefs?.tailoring_tone as Tone) || "professional";
  const modelChoice: ModelChoice = (prefs?.tailoring_model as ModelChoice) || "sonnet";

  let model: LanguageModel;
  const directKey = userKey || sharedKey;
  if (directKey) {
    model = createAnthropic({ apiKey: directKey })(MODELS[modelChoice].directId);
  } else {
    model = MODELS[modelChoice].gatewayId;
  }

  const promptArgs = {
    resume: resumeForPrompt,
    jobDescription: body.jobDescription,
    role: body.role,
    company: body.company,
    tone,
  };

  const clientAbort = req.signal;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      controller.enqueue(encoder.encode(`: ping\n\n`));
      send("meta", { tone, model: modelChoice, blocks: requested });

      const runBlock = async (block: TailorBlock) => {
        if (clientAbort.aborted || closed) return null;

        // Match block: try the cache first. If we have a stored result for
        // this (resume_hash, jobId), serve it immediately and skip the call.
        if (block === "match" && body.jobId) {
          const cached = await readMatchCache(supabase, resumeHash, body.jobId);
          if (cached) {
            send("start", { block, cached: true });
            send("done", { block, data: cached });
            return cached;
          }
        }

        send("start", { block });
        const prompt = BLOCK_PROMPTS[block](promptArgs);

        const maxOutputTokens =
          block === "cover" ? 3200 :
          block === "prep" ? 2800 :
          block === "referral" ? 1800 :
          block === "strategy" ? 1600 :
          block === "keywords" ? 1800 :
          block === "bullets" ? 1800 :
          block === "jd_hygiene" ? 1200 :
          block === "short_cover" ? 800 :
          1400;

        try {
          let parsed: any;
          const schema = (STRUCTURED_SCHEMAS as Record<string, any>)[block];
          if (schema) {
            // generateObject handles its own JSON-retry loop.
            const { object } = await generateObject({
              model,
              prompt,
              schema,
              maxOutputTokens,
              abortSignal: clientAbort,
            });
            parsed = object;
          } else {
            const { text } = await generateText({
              model,
              prompt,
              maxOutputTokens,
              abortSignal: clientAbort,
            });
            parsed = parseJsonLoosely(text);
            if (!parsed) {
              const retry = await generateText({
                model,
                prompt,
                maxOutputTokens: Math.round(maxOutputTokens * 1.6),
                abortSignal: clientAbort,
              });
              parsed = parseJsonLoosely(retry.text);
            }
          }

          if (!parsed) {
            send("error", { block, error: "Model returned unparseable output." });
            return null;
          }

          parsed = stripEmDashes(parsed);
          send("done", { block, data: parsed });

          if (block === "match" && body.jobId) {
            // Persist to job row + cache so the next visit is instant.
            if (typeof parsed.score === "number") {
              await supabase
                .from("jobs")
                .update({
                  tailor_score: Math.round(parsed.score),
                  tailor_reasoning: typeof parsed.headline === "string" ? parsed.headline : "",
                })
                .eq("id", body.jobId)
                .eq("user_id", user.id);
            }
            await writeMatchCache(supabase, user.id, resumeHash, body.jobId, parsed);
          }

          return parsed;
        } catch (err) {
          if (clientAbort.aborted) {
            send("aborted", { block });
            return null;
          }
          captureError(err, { route: "tailor", block, userId: user.id });
          send("error", {
            block,
            error: err instanceof Error ? err.message : "Unknown error.",
          });
          return null;
        }
      };

      if (requested.includes("match")) {
        await runBlock("match");
      }
      const rest = requested.filter((b) => b !== "match");
      await Promise.all(rest.map((b) => runBlock(b)));

      send("complete", {});
      closed = true;
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
    cancel() {
      // Abort signal already cancels in-flight model calls.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ---- helpers -------------------------------------------------------------

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function parseJsonLoosely(text: string): any | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function stripEmDashes(value: unknown): any {
  if (typeof value === "string") {
    return value
      .replace(/\u2014/g, ", ")
      .replace(/\u2013/g, "-")
      .replace(/\s+,/g, ",");
  }
  if (Array.isArray(value)) return value.map(stripEmDashes);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripEmDashes(v);
    }
    return out;
  }
  return value;
}

async function readMatchCache(
  supabase: Awaited<ReturnType<typeof createClient>>,
  resumeHash: string,
  jobId: string,
): Promise<any | null> {
  try {
    const { data } = await supabase
      .from("match_cache")
      .select("data")
      .eq("resume_hash", resumeHash)
      .eq("job_id", jobId)
      .maybeSingle();
    return data?.data ?? null;
  } catch {
    return null;
  }
}

async function writeMatchCache(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  resumeHash: string,
  jobId: string,
  data: any,
): Promise<void> {
  try {
    await supabase
      .from("match_cache")
      .upsert(
        { user_id: userId, resume_hash: resumeHash, job_id: jobId, data },
        { onConflict: "resume_hash,job_id" },
      );
  } catch (e) {
    captureError(e, { route: "tailor", stage: "write_match_cache" });
  }
}

async function checkAndBumpRateLimit(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const { data: row } = await supabase
      .from("tailor_usage")
      .select("count")
      .eq("user_id", userId)
      .eq("day", day)
      .maybeSingle();

    const current = (row?.count as number | undefined) ?? 0;
    if (current >= DAILY_LIMIT) return false;

    await supabase
      .from("tailor_usage")
      .upsert(
        { user_id: userId, day, count: current + 1 },
        { onConflict: "user_id,day" },
      );
    return true;
  } catch (e) {
    captureError(e, { route: "tailor", stage: "rate_limit" });
    return true;
  }
}
