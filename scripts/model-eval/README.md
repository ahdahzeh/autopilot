# Model comparison

Runs the real tailor prompts against one or more models and scores the output
with the same validator the API route uses (`src/lib/output-guard.ts`).

The question is not "is this model good". It is "does this model satisfy the
contract our prompts already state", which is what decides whether it is safe
to route production traffic to it.

```bash
# local models, free, needs Ollama running
npm run eval:models -- --models=gemma3:12b,qwen3:8b

# hosted open models, needs AI_GATEWAY_API_KEY
npm run eval:models -- --models=moonshotai/kimi-k2,zai/glm-4.7-flash

# Claude direct, needs ANTHROPIC_API_KEY
npm run eval:models -- --models=claude-sonnet-4-6,claude-haiku-4-5-20251001

# just the blocks that matter, and measure the retry
npm run eval:models -- --models=gemma3:12b --blocks=bullets,cover --retry
```

Backend is inferred from the model id: `gemma3:12b` (a colon) goes to Ollama,
`anthropic/claude-haiku-4.5` (a slash) goes to the Vercel AI Gateway, and a
bare `claude-sonnet-4-6` goes straight to the Anthropic API.

`--retry` re-runs violating blocks with the same correction suffix production
uses, so the pass rate reported matches what a user would actually receive.

Progress goes to stderr, the full result rows go to stdout as JSON:

```bash
npm run eval:models -- --models=gemma3:12b > results.json
```

## Reading the output

A block is clean when `auditBlock` returns no violations. Punctuation and
quote style never appear there, because `normalizeDeep` fixes those without
asking the model. What is left is the set of failures that need different
words: banned phrases, invented figures, wrong item counts, wrong word counts.

## What the first run found (2026-08-30)

Against `llama3:8b`, `gemma3:12b` and `qwen3:8b`, with the Claude baseline
unavailable (zero API credit) and hosted open models unavailable (the gateway
requires a card on file):

- The short structured blocks held up. Match scoring, the highest-volume LLM
  call in the product, passed on 8B and 12B models.
- No model cleared the cover letter. All three came in 150 to 200 words short
  of the 480 to 520 the prompt requires, and every one of them misreported its
  own word count, so the model's `word_count` field cannot be used as a check.
- `llama3:8b` invented a "67% reduction" that appears nowhere in the resume.
  `gemma3:12b` invented nothing across both prose blocks. That is the axis
  worth choosing a model on.

## Not covered

`title-expansion.ts` and `resume-audit.ts` build their prompts inline rather
than exporting them, so they are not in `BLOCK_PROMPTS` and this harness does
not reach them. Both are worth testing before moving either to a cheaper model:
in the first run, two of three models returned confidently wrong audit findings
("no skills section" for a resume that has one).
