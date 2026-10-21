import { createHash, randomUUID } from "node:crypto";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText, type LanguageModel } from "ai";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { captureError } from "@/lib/sentry";
import { sumTokenUsage, tokenUsageOf, type PaidWith, type TokenUsage } from "@/lib/billing";
import {
  capReachedBody,
  loadBillingState,
  recordTailorEvent,
  refundTailorCredit,
  reserveTailor,
} from "@/lib/billing-server";
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
import {
  auditBlock,
  correctWordCounts,
  correctionSuffix,
  normalizeDeep,
  type Violation,
} from "@/lib/output-guard";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Blocks that go through generateObject (auto-retry, schema-validated).
// Everything else stays on generateText because the output is prose-shaped
// (cover letter paragraphs, interview Q/A, referral copy) and a strict
// schema would only fight the model.
const STRUCTURED_SCHEMAS = {
  match: matchSchema,
  keywords: keywordsSchema,
  strategy: strategySchema,
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = {
  jobDescription: string;
  role: string;
  company: string;
  jobId?: string;
  blocks?: TailorBlock[];
  // false: at the daily cap, refuse instead of spending a purchased credit.
  // The modal's automatic cover draft sends this; a click on Tailor does not.
  spendCredit?: boolean;
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

  // Pull resume_text + resume_summary together. The summary is generated at
  // upload time for resumes >6000 chars; if it exists we feed it to the
  // model instead of an arbitrary slice of the raw text.
  //
  // Everything the request needs is validated before the cap or a credit is
  // touched, so a request that fails here costs the user nothing.
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
  // The exact id sent to the provider, stored on every usage row so cost can
  // be computed per model later (src/lib/billing.ts has the prices).
  const modelId = directKey ? MODELS[modelChoice].directId : MODELS[modelChoice].gatewayId;

  // Cap or credit. Under TAILOR_DAILY_LIMIT (src/lib/billing.ts, 20 since
  // 2026-10-20, 40 before) the run counts against the free allowance; at the
  // cap it spends a purchased credit; with neither it is refused. Users with
  // their own Anthropic key pay Anthropic directly and are never capped.
  // (Until 2026-10-20 this check ran before the key was loaded, so the
  // exemption the settings page promised never applied.)
  let paidWith: PaidWith = "own_key";
  if (!userKey) {
    const reservation = await reserveTailor(supabase, user.id, {
      allowCredit: body.spendCredit !== false,
    });
    if (!reservation) {
      // Loaded only on this path: the numbers pick the wording and let the
      // modal show where the user stands without a second request.
      const state = await loadBillingState(supabase, user.id, { hasOwnKey: false });
      return Response.json(
        capReachedBody(state, {
          creditWithheld: body.spendCredit === false && state.credits > 0,
        }),
        { status: 429 },
      );
    }
    paidWith = reservation.paidWith;
  }

  // Usage rows and refunds are written with the service role, so the log
  // cannot be padded from a browser session.
  const service = createServiceClient();
  const requestId = randomUUID();
  const jobId = body.jobId && UUID_RE.test(body.jobId) ? body.jobId : null;

  const promptArgs = {
    resume: resumeForPrompt,
    jobDescription: body.jobDescription,
    role: body.role,
    company: body.company,
    tone,
  };

  // Figures are checked against the FULL resume, not the truncated prompt
  // copy, so a real number living past the 8000 char cut is not called a
  // fabrication. The job description counts as a citable source too.
  const auditCtx = {
    resume: rawResume,
    jobDescription: body.jobDescription,
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
      send("meta", { tone, model: modelChoice, blocks: requested, paidWith });

      let okBlocks = 0;
      let abortedBlocks = 0;
      const pendingLogs: Promise<void>[] = [];

      const runBlock = async (block: TailorBlock) => {
        if (clientAbort.aborted || closed) return null;

        // Match block: try the cache first. If we have a stored result for
        // this (resume_hash, jobId), serve it immediately and skip the call.
        if (block === "match" && body.jobId) {
          const cached = await readMatchCache(supabase, resumeHash, body.jobId);
          if (cached) {
            send("start", { block, cached: true });
            send("done", { block, data: cached });
            okBlocks += 1;
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

        // One entry per model call, so a block's row in tailor_events carries
        // the retries it needed as well as the first attempt. tokenUsageOf
        // keeps cached tokens out of input_tokens (see src/lib/billing.ts).
        const calls: TokenUsage[] = [];
        const logUsage = (ok: boolean) => {
          if (calls.length === 0) return;
          const total = sumTokenUsage(calls);
          pendingLogs.push(
            recordTailorEvent(service, {
              user_id: user.id,
              request_id: requestId,
              job_id: jobId,
              block,
              model: modelId,
              calls: calls.length,
              input_tokens: total.inputTokens,
              output_tokens: total.outputTokens,
              cache_read_tokens: total.cacheReadTokens ?? 0,
              cache_write_tokens: total.cacheWriteTokens ?? 0,
              paid_with: paidWith,
              ok,
            }),
          );
        };

        const schema = (STRUCTURED_SCHEMAS as Record<string, any>)[block];
        const generateOnce = async (text: string, tokens: number): Promise<any> => {
          if (schema) {
            // generateObject handles its own JSON-retry loop.
            const { object, usage } = await generateObject({
              model,
              prompt: text,
              schema,
              maxOutputTokens: tokens,
              abortSignal: clientAbort,
            });
            calls.push(tokenUsageOf(usage));
            return object;
          }
          const { text: raw, usage } = await generateText({
            model,
            prompt: text,
            maxOutputTokens: tokens,
            abortSignal: clientAbort,
          });
          calls.push(tokenUsageOf(usage));
          return parseJsonLoosely(raw);
        };

        try {
          let parsed: any = await generateOnce(prompt, maxOutputTokens);
          if (!parsed) {
            // Truncation is the usual cause, so give the retry more room.
            parsed = await generateOnce(prompt, Math.round(maxOutputTokens * 1.6));
          }

          if (!parsed) {
            send("error", { block, error: "Model returned unparseable output." });
            logUsage(false);
            return null;
          }

          // Punctuation and quote style are fixed silently; a model cannot do
          // a character substitution better than we can.
          parsed = correctWordCounts(block, normalizeDeep(parsed));

          // What is left needs different words, so it costs one retry. See
          // src/lib/output-guard.ts for why this exists.
          let violations: Violation[] = auditBlock(block, parsed, auditCtx);
          if (violations.length > 0) {
            const second = await generateOnce(
              prompt + correctionSuffix(violations),
              maxOutputTokens,
            );
            if (second) {
              const cleaned = correctWordCounts(block, normalizeDeep(second));
              const after = auditBlock(block, cleaned, auditCtx);
              // Keep whichever attempt broke fewer rules. A retry that makes
              // things worse should not win just because it went second.
              if (after.length < violations.length) {
                parsed = cleaned;
                violations = after;
              }
            }
          }

          send("done", {
            block,
            data: parsed,
            violations: violations.length > 0 ? violations : undefined,
          });
          okBlocks += 1;
          logUsage(true);

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
            abortedBlocks += 1;
            send("aborted", { block });
            logUsage(false);
            return null;
          }
          captureError(err, { route: "tailor", block, userId: user.id });
          send("error", {
            block,
            error: err instanceof Error ? err.message : "Unknown error.",
          });
          logUsage(false);
          return null;
        }
      };

      if (requested.includes("match")) {
        await runBlock("match");
      }
      const rest = requested.filter((b) => b !== "match");
      await Promise.all(rest.map((b) => runBlock(b)));

      // A credit that bought nothing goes back: every block failed outright
      // and the user did not abort. Partial runs keep the charge, the same
      // way the daily counter has always kept its slot.
      let refunded = false;
      if (paidWith === "credit" && okBlocks === 0 && abortedBlocks === 0) {
        await refundTailorCredit(service, user.id);
        refunded = true;
      }

      // The usage rows must land before the stream closes; on serverless
      // nothing is guaranteed to run after the response ends.
      await Promise.all(pendingLogs);

      send("complete", { refunded });
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
