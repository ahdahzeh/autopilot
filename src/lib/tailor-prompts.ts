// Prompt library for the multi-pass tailoring pipeline.
//
// Each block (match, keywords, bullets, cover, short_cover, jd_hygiene,
// strategy, prep, referral) gets its own prompt so we can stream them
// independently and tune each without affecting the others. Tone variants
// are layered as a system-prompt prefix.

export type Tone = "professional" | "conversational" | "technical" | "executive";

export const TONES: Record<Tone, { label: string; description: string; prefix: string }> = {
  professional: {
    label: "Professional",
    description: "Polished, neutral, hireable. Default for most users.",
    prefix:
      "Write in a polished, professional tone. Confident but not flashy. Avoid jargon, buzzwords, and clichés. Use plain, direct language.",
  },
  conversational: {
    label: "Conversational",
    description: "Warmer, first-person voice. Good for startups, design, founding roles.",
    prefix:
      "Write in a warm, first-person, human tone, like a talented operator talking to another smart person. No corporate-speak. Confident but personable.",
  },
  technical: {
    label: "Technical",
    description: "Precise, metric-heavy. Best for engineering and IC roles.",
    prefix:
      "Write in a precise, technical tone. Lead with metrics, systems, and outcomes. Assume the reader is technical, so skip explanations of common concepts.",
  },
  executive: {
    label: "Executive",
    description: "Strategic, outcome-led. For leadership and senior IC roles.",
    prefix:
      "Write in an executive tone: strategic, outcome-led, and confident. Emphasize scope, impact, and decisions. Quantify wherever possible.",
  },
};

export type ModelChoice = "sonnet" | "haiku";

// Two IDs per model: the gateway uses dotted versioning (`claude-sonnet-4.6`),
// the direct Anthropic API uses dashed/dated IDs. The route picks one based on
// whether the user supplied their own Anthropic key.
export const MODELS: Record<
  ModelChoice,
  { directId: string; gatewayId: string; label: string; description: string }
> = {
  sonnet: {
    directId: "claude-sonnet-4-6",
    gatewayId: "anthropic/claude-sonnet-4.6",
    label: "Sonnet 4.6 (best)",
    description: "Highest quality. ~5 to 10s per block. Default.",
  },
  haiku: {
    directId: "claude-haiku-4-5-20251001",
    gatewayId: "anthropic/claude-haiku-4.5",
    label: "Haiku 4.5 (fast)",
    description: "Faster and cheaper. ~2 to 4s per block. Good for drafts.",
  },
};

// Output hygiene rules every prompt inherits. Keep these tight. Every rule
// here exists because a real model output violated it at least once.
const OUTPUT_RULES = `
OUTPUT RULES (NON-NEGOTIABLE):
- Never use em-dashes. The character "—" is banned. Also do not use en-dashes "–" as sentence punctuation. Use commas, periods, semicolons, colons, or parentheses instead.
- Never use the phrases "I am writing to", "I hope this finds you well", "As a passionate", "proven track record", "results-driven", "synergy", or "leverage" as a verb.
- No emoji in any generated text.
- No curly smart-quotes. Use straight quotes only.
- When you open a sentence with a dependent clause, end it with a comma, not a dash.
`.trim();

const TRUTHFULNESS = `
TRUTHFULNESS RULES (NON-NEGOTIABLE):
- Never invent jobs, companies, dates, metrics, technologies, or accomplishments not present in the resume.
- You may rephrase, reorder, and emphasize differently, but every concrete claim must be traceable to the resume.
- If the resume lacks direct evidence for something the job requires, translate a transferable accomplishment honestly (name the analogue) rather than fabricating one, or flag the gap in the relevant section.
- Numbers (%, $, headcount, etc.) must come from the resume verbatim. Do not estimate or round.
- When the candidate is a career switcher or has a non-linear background, prefer framing transferable scope and outcomes over chronological job titles.
`.trim();

const IMPACT_FRAMING = `
IMPACT FRAMING (apply to every claim you write about the candidate):
- Lead with the outcome, then the action, then the context. Not the reverse.
- Prefer verbs of consequence: shipped, unblocked, saved, won, reduced, grew, launched, resolved, decided.
- Where a metric exists in the resume, put it in the first half of the sentence.
- Where no metric exists, quantify scope instead: team size, audience size, surface area, number of stakeholders, duration, budget.
- Translate task-level work into business-level impact: "redesigned checkout" becomes "redesigned checkout, lifting conversion by X%" if the metric exists, or "redesigned checkout across 4 markets" if only scope is known.
- Never describe the candidate as responsible for or involved in something. Describe what they changed.
`.trim();

function withTone(tone: Tone, body: string): string {
  return `${TONES[tone].prefix}\n\n${OUTPUT_RULES}\n\n${TRUTHFULNESS}\n\n${IMPACT_FRAMING}\n\n${body}`.trim();
}

type PromptArgs = {
  resume: string;
  jobDescription: string;
  role: string;
  company: string;
  tone: Tone;
};

// ---- Block 1: Match score + reasoning ------------------------------------

export function matchPrompt(args: PromptArgs): string {
  const { resume, jobDescription, role, company, tone } = args;
  return withTone(
    tone,
    `
Score how well this candidate matches the role on a 0 to 100 scale, then explain.

<resume>
${resume.slice(0, 8000)}
</resume>

<job>
Role: ${role}
Company: ${company}
Description:
${jobDescription.slice(0, 6000)}
</job>

Output STRICT JSON with this shape and nothing else:
{
  "score": <integer 0-100>,
  "headline": "<one sentence summary of fit>",
  "strengths": ["<concrete strength tied to resume evidence>", ...3-5 items],
  "gaps": ["<honest gap with how to address it>", ...1-3 items],
  "verdict": "strong" | "decent" | "stretch" | "mismatch"
}

Scoring rubric:
- 90-100: Direct fit. Resume shows clear evidence for at least 80% of requirements.
- 75-89: Strong fit. Most requirements covered, 1 to 2 stretch areas.
- 60-74: Decent fit. Half the requirements covered, real gaps but applyable.
- 40-59: Stretch. Transferable skills but missing core requirements.
- 0-39: Mismatch. Save the user time and tell them honestly.
`.trim()
  );
}

// ---- Block 2: ATS keyword coverage ---------------------------------------
// Recruiters and their ATS filter by keyword. This block produces a gap list
// and placement recommendations the candidate can act on immediately.

export function keywordsPrompt(args: PromptArgs): string {
  const { resume, jobDescription, role, company, tone } = args;
  return withTone(
    tone,
    `
Extract the keywords an applicant tracking system (Greenhouse, Lever, Workday, Ashby) would score this candidate on for this role. Compare against the resume.

<resume>
${resume.slice(0, 8000)}
</resume>

<job>
Role: ${role}
Company: ${company}
Description:
${jobDescription.slice(0, 6000)}
</job>

Rules:
- Pull 10 to 15 keywords total. Mix: hard skills, tools, methodologies, domain terms, seniority signals.
- For each keyword, judge whether the resume already contains it (semantic match is fine, exact string is better).
- For missing keywords, propose a truthful insertion point: a resume bullet the candidate could slightly rephrase, or a skills line the term could live in. Never invent experience.
- Flag any keyword that would be dishonest to claim as "do_not_claim".

Output STRICT JSON, nothing else:
{
  "keywords": [
    {
      "term": "<keyword>",
      "status": "present" | "missing" | "do_not_claim",
      "priority": "high" | "medium" | "low",
      "insertion_hint": "<if missing and claimable: the resume bullet to edit and how, in one sentence. If present: empty string. If do_not_claim: why it would be dishonest, in one sentence.>"
    },
    ...10-15 items
  ],
  "coverage_score": <integer 0-100, share of high-priority keywords present>,
  "summary": "<one sentence read on ATS risk and the single most important fix>"
}
`.trim()
  );
}

// ---- Block 3: Resume bullets (conservative rewrite) ----------------------

export function bulletsPrompt(args: PromptArgs): string {
  const { resume, jobDescription, role, company, tone } = args;
  return withTone(
    tone,
    `
Rewrite the 5 most relevant bullets from the resume to maximize fit for this role.

<resume>
${resume.slice(0, 8000)}
</resume>

<job>
Role: ${role}
Company: ${company}
Description:
${jobDescription.slice(0, 6000)}
</job>

You MAY:
- Re-order words and clauses for emphasis
- Swap synonyms to mirror the job's language (e.g. "drove" to "led", "users" to "customers")
- Front-load the metric or outcome
- Tighten verbose phrasing
- Surface a sub-accomplishment that was buried inside an existing bullet
- Translate task-level phrasing into business-level impact when the resume supplies the outcome

You MAY NOT:
- Invent metrics, technologies, scope, or outcomes that aren't already in the resume
- Combine work from different roles into one bullet
- Change the employer, role title, or dates
- Use em-dashes or en-dashes in any output

Each rewritten bullet must open with a verb of consequence (shipped, unblocked, saved, won, reduced, grew, launched, resolved, decided, cut, raised) and put the most load-bearing number or scope marker in its first half.

For each bullet, return BOTH the original phrasing (for the user's reference) AND your rewrite.

Output STRICT JSON, nothing else:
{
  "bullets": [
    {
      "original": "<exact text from resume>",
      "rewritten": "<your improved version, same facts>",
      "why": "<one short line: why this lands for THIS job>"
    },
    ...exactly 5 items
  ]
}
`.trim()
  );
}

// ---- Block 4: Full cover letter (500 words, impact-positioned) -----------

export function coverPrompt(args: PromptArgs): string {
  const { resume, jobDescription, role, company, tone } = args;
  return withTone(
    tone,
    `
Write a full cover letter for this role. The letter must be 480 to 520 words total across 5 paragraphs. Its single job is to position the candidate as someone who will be impactful in this specific role from week one.

<resume>
${resume.slice(0, 8000)}
</resume>

<job>
Role: ${role}
Company: ${company}
Description:
${jobDescription.slice(0, 6000)}
</job>

Structure (treat as a rubric, not a template):
1. Hook (90 to 110 words). Open with a specific, concrete reason this company or role caught the candidate's attention. Reference a real product, mission, shipped feature, technical problem, market move, or public post. Do not use "I am writing to apply for". Do not start with the candidate's own name or title. End paragraph one with a one-sentence thesis of how the candidate will create value for this specific team.
2. Proof of impact (120 to 140 words). Pick the two single most relevant accomplishments from the resume. For each, write one compact story: the problem, the action the candidate took, the measurable outcome. Use numbers that appear in the resume verbatim. Where the resume lacks a percent or dollar figure, use scope (audience, team size, surface area, duration). Bridge each story to an equivalent problem the job description names.
3. Transferable pattern (90 to 110 words). Show the candidate's repeatable operating pattern, the thing they do well across contexts. Name the pattern in plain language (for example: "I specialize in turning ambiguous research signal into shipped product calls"). Back it with a second piece of resume evidence, different from paragraph two. Tie the pattern to a responsibility the job description explicitly names.
4. Why this company (110 to 130 words). Show genuine understanding of what the company is doing and why it matches the candidate's trajectory. Be specific about the product, the moment the company is in, or the problem space. Avoid generic praise. Connect their mission to something the candidate has already done or clearly moves toward. This is where cultural and trajectory fit is earned.
5. Close (50 to 60 words). Short, confident, no begging, no thanking in advance. One forward-looking sentence that frames the conversation as mutual discovery. One clear ask for a next step.

Hard rules:
- No em-dashes. No en-dashes as punctuation. If you feel the urge to insert one, use a comma, a period, a semicolon, a colon, or a parenthesis.
- Never claim a skill, metric, tool, or outcome not present in the resume.
- The candidate is the subject of every sentence of consequence. Lead with verbs of action, not "I have been" or "I was responsible for".
- The word "passionate" is banned. The phrase "proven track record" is banned. "Results-driven" is banned.
- If the role is a stretch relative to the candidate's resume, address that honestly in paragraph three by naming the closest adjacent experience. Do not bluff.
- Total word count MUST fall between 480 and 520. Count before returning.

Output STRICT JSON, nothing else:
{
  "paragraphs": ["<p1>", "<p2>", "<p3>", "<p4>", "<p5>"],
  "word_count": <integer total word count across all 5 paragraphs>,
  "subject_line": "<suggested email subject line, under 70 characters, no em-dashes>",
  "impact_thesis": "<one sentence: the single argument this letter is making about why the candidate will be impactful here>"
}
`.trim()
  );
}

// ---- Block 5: Short-form cover (email / LinkedIn DM, ~120 words) ---------

export function shortCoverPrompt(args: PromptArgs): string {
  const { resume, jobDescription, role, company, tone } = args;
  return withTone(
    tone,
    `
Write a short-form cover message suitable for a LinkedIn message, a recruiter email, or a one-paragraph application field. 110 to 140 words, one or two short paragraphs.

<resume>
${resume.slice(0, 8000)}
</resume>

<job>
Role: ${role}
Company: ${company}
Description:
${jobDescription.slice(0, 6000)}
</job>

Rules:
- First sentence names the specific product, feature, or problem at the company that triggered outreach. No "I came across".
- Middle sentences deliver one proof point from the resume with a real number or real scope, tied to a need the job calls out.
- Last sentence asks for a 20 minute conversation or points to the portfolio/resume attachment.
- Every sentence carries weight. If a sentence could be deleted with no loss, delete it.
- No em-dashes. No emoji. No signoff pleasantries past "Best,".

Output STRICT JSON, nothing else:
{
  "message": "<the full short-form message, 110-140 words>",
  "word_count": <integer>,
  "opening_variant": "<alternative first sentence that works if the candidate is applying cold with no shared context>"
}
`.trim()
  );
}

// ---- Block 6: JD hygiene (ghost job / red flag screen) -------------------

export function jdHygienePrompt(args: PromptArgs): string {
  const { jobDescription, role, company, tone } = args;
  return withTone(
    tone,
    `
Read this job description the way an experienced recruiter would. Flag signals that suggest a ghost listing, reposted req, unclear scope, inflated title, or troubled team. The goal is to save the candidate time.

<job>
Role: ${role}
Company: ${company}
Description:
${jobDescription.slice(0, 6000)}
</job>

Signals to consider:
- Vague scope, missing team context, no named manager or partner teams
- Title inflation (senior/staff title with IC-junior scope, or vice versa)
- Unicorn requirement stacks (for example, designer who also ships production React, writes SQL, runs user research, owns roadmap)
- Salary band missing in jurisdictions that require it
- Language implying understaffed or rescue work without the seniority to match
- Copy reused verbatim across many reqs
- Red-flag phrases: "wear many hats", "rockstar", "family not a team", "fast-paced environment" without substance, "competitive salary"

Output STRICT JSON, nothing else:
{
  "listing_quality": "clean" | "mixed" | "suspicious",
  "flags": [
    {
      "signal": "<what you saw>",
      "severity": "low" | "medium" | "high",
      "interpretation": "<one sentence: what this likely means for the role>"
    },
    ...0-5 items
  ],
  "questions_to_verify_before_applying": ["<specific question the candidate should get answered, often via recruiter screen or contact inside>", ...2-4 items],
  "apply_recommendation": "<one sentence: apply, apply with caution, or skip, and the single reason why>"
}
`.trim()
  );
}

// ---- Block 7: Strategy / positioning / level / salary --------------------

export function strategyPrompt(args: PromptArgs): string {
  const { resume, jobDescription, role, company, tone } = args;
  return withTone(
    tone,
    `
Give the candidate a strategic read on how to position themselves for THIS role. Assume a stretch is possible and coach accordingly.

<resume>
${resume.slice(0, 8000)}
</resume>

<job>
Role: ${role}
Company: ${company}
Description:
${jobDescription.slice(0, 6000)}
</job>

For positioning, explicitly answer:
- Which past role on the resume should the candidate lead with (first thing out of their mouth in a recruiter screen)?
- Which past role should the candidate downplay or mention only briefly, because it dilutes the narrative for this job?
- If the title on the resume is lower than the title being applied for, what honest title-bridging language can the candidate use (for example: "designer who operated at PM scope on X")? If no such bridge exists, say so.

For salary, be explicit about your assumptions. State the geography signal you are using (role location), the seniority read, and the rough band you believe applies. Call it an estimate.

Output STRICT JSON, nothing else:
{
  "level_read": "<one sentence: at, above, or below the candidate's current level, and what to do about it>",
  "positioning": {
    "lead_with_role": "<role title and company from resume, plus one sentence on why this one leads>",
    "downplay_role": "<role title and company from resume, plus one sentence on why this one dilutes, OR empty string if none>",
    "title_bridge": "<one to two sentence framing the candidate can use verbatim to explain fit despite a title gap, OR empty string if no bridge needed>",
    "story_arc": "<one sentence: the single throughline tying the candidate's career to this role>"
  },
  "salary_lens": {
    "assumption": "<one sentence: geography + seniority read you're using>",
    "band_estimate": "<rough annual band as a string, for example '$160-200k base US-remote senior IC', or 'insufficient signal' if you cannot estimate>",
    "negotiation_angle": "<one sentence: the strongest leverage point the candidate has given their resume>"
  },
  "risks": [
    {
      "risk": "<a real risk in pursuing this role>",
      "mitigation": "<what to do about it, one sentence>"
    },
    ...1-3 items
  ]
}
`.trim()
  );
}

// ---- Block 8: Interview prep ---------------------------------------------

export function interviewPrompt(args: PromptArgs): string {
  const { resume, jobDescription, role, company, tone } = args;
  return withTone(
    tone,
    `
Predict the most likely interview questions for this role and draft strong starter answers grounded in the resume.

<resume>
${resume.slice(0, 8000)}
</resume>

<job>
Role: ${role}
Company: ${company}
Description:
${jobDescription.slice(0, 6000)}
</job>

Output STRICT JSON, nothing else:
{
  "questions": [
    {
      "q": "<the question>",
      "category": "behavioral" | "role_specific" | "why_company" | "stretch_or_gap",
      "why": "<why they will likely ask this>",
      "answer_seed": "<2-3 sentence STAR-format opener using a real moment from the resume. Lead with the outcome, not the setup.>"
    },
    ...exactly 8 items, at least one from each category, including one that directly probes the biggest gap the match block would flag
  ],
  "questions_to_ask_them": [
    {
      "q": "<sharp question that signals seriousness>",
      "signals": "<what asking this tells the interviewer about the candidate, one phrase>"
    },
    ...exactly 4 items: one about the team, one about the role's success criteria, one about the product or technical problem, one about culture or decision-making>
  ]
}
`.trim()
  );
}

// ---- Block 9: Referral / warm intro draft --------------------------------

export function referralPrompt(args: PromptArgs): string {
  const { resume, jobDescription, role, company, tone } = args;
  return withTone(
    tone,
    `
Draft warm outreach artifacts the candidate can send to a second-degree connection or a cold contact at the company. The goal is a referral, an internal nudge, or an informational call, not a pitch.

<resume>
${resume.slice(0, 8000)}
</resume>

<job>
Role: ${role}
Company: ${company}
Description:
${jobDescription.slice(0, 6000)}
</job>

Write three short artifacts:
1. A LinkedIn connection-request note, under 300 characters total, that gives a genuine reason to connect.
2. A short follow-up DM once the connection accepts, 90 to 120 words, that names the specific role, offers one proof point from the resume, and asks for 15 minutes of the recipient's time (not an endorsement).
3. A cold email the candidate could send to someone at the company without a mutual connection, 130 to 160 words, that opens with a specific observation about the company's work, offers one proof point, and asks a low-pressure question the recipient can answer in two sentences.

Rules:
- No flattery. No "huge fan". No "I know you're busy".
- No em-dashes, no emoji.
- Every artifact names the role and company explicitly.
- Every artifact has a single, scoped ask.

Output STRICT JSON, nothing else:
{
  "connection_note": "<under 300 characters>",
  "follow_up_dm": "<90-120 words>",
  "cold_email": {
    "subject": "<under 60 characters>",
    "body": "<130-160 words>"
  }
}
`.trim()
  );
}

export const TAILOR_BLOCKS = [
  "match",
  "keywords",
  "bullets",
  "cover",
  "short_cover",
  "jd_hygiene",
  "strategy",
  "prep",
  "referral",
] as const;
export type TailorBlock = (typeof TAILOR_BLOCKS)[number];

export const BLOCK_PROMPTS: Record<TailorBlock, (args: PromptArgs) => string> = {
  match: matchPrompt,
  keywords: keywordsPrompt,
  bullets: bulletsPrompt,
  cover: coverPrompt,
  short_cover: shortCoverPrompt,
  jd_hygiene: jdHygienePrompt,
  strategy: strategyPrompt,
  prep: interviewPrompt,
  referral: referralPrompt,
};
