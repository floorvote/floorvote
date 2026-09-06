import { GoogleGenAI, ServiceTier } from '@google/genai'
import type { TaxonomyItem } from './taxonomy'
import type { Env } from '../types'

// ── Shared types ──────────────────────────────────────────────────────────────

interface ProcessBillParams {
  billNumber: string
  title: string
  text: string
  pdfBase64?: string
  taxonomy: TaxonomyItem[]
  aiContext?: string
  relevanceQuestion?: string
}

interface ProcessBillResult {
  summary: string
  tags: string[]
  relevanceScore: number
  /** Statutory citations the bill affects, verbatim as printed in the bill. */
  affectedCitations: string[]
}

// ── Shared constants ──────────────────────────────────────────────────────────

/**
 * Response schema for one bill analysis. Built per call because `tags` is constrained to
 * the tenant's taxonomy: under constrained decoding the model cannot emit a non-member, so
 * it picks the nearest real entry rather than inventing one that write-time filtering would
 * silently drop (turning a wrong tag into a missing tag).
 *
 * Verified 2026-08-17 against the live API through the AI Gateway: the enum is enforced at
 * decode time, not merely suggested — a nonsense enum with `minItems: 1` forced an absurd
 * but in-enum answer. Which is also why `minItems` is deliberately NOT set here: without it
 * the model still returns `[]` when nothing fits, preserving the prompt's explicit allowance
 * that assigning no tags can be correct.
 *
 * An empty taxonomy would produce `enum: []`, which is not a valid schema, so that case
 * falls back to unconstrained strings. `loadEffectiveTaxonomy` makes this unreachable from
 * the bill pipeline (it falls back to DEFAULT_TAXONOMY), but processBill is called directly
 * with an empty taxonomy in tests.
 *
 * Uniqueness is NOT expressible here — the SDK's Schema type has no `uniqueItems` — so
 * duplicates are removed downstream by filterTagsToTaxonomy in lib/taxonomy.ts.
 */
export function buildAnalysisSchema(taxonomy: TaxonomyItem[]) {
  const names = taxonomy.map(t => t.name).filter(n => n.length > 0)
  const tagItems = names.length > 0
    ? { type: 'string', format: 'enum', enum: names }
    : { type: 'string' }
  // affectedCitations is generated FIRST — see propertyOrdering below.
  const ordering = ['affectedCitations', 'summary', 'tags', 'relevanceScore']
  return {
    type: 'object',
    properties: {
      affectedCitations: {
        type: 'array',
        items: { type: 'string' },
        description: 'Statutory citations this bill affects, exactly as printed in the bill.',
      },
      summary: { type: 'string' },
      tags: { type: 'array', items: tagItems },
      relevanceScore: { type: 'integer', description: 'An integer from 1 to 10 inclusive.' },
    },
    // Generation is autoregressive, so field order is the order the model commits
    // to answers. Citations come first so the extraction is in context before the
    // tag and relevance judgements that may depend on it. Every field is required,
    // which Google's own troubleshooting guidance pairs with a defined order to
    // stop the model drifting out of it.
    //
    // Measured 2026-09-05: ordering is honoured (citations arrived first in 12/12
    // calls). Ordering alone does NOT fix tag accuracy — an older model extracted
    // correctly and still tagged on subject matter. It is the extraction that is
    // worth having here, not a claim about judgement.
    propertyOrdering: ordering,
    required: ordering,
    additionalProperties: false,
  }
}

// These two texts intentionally differ from shared/aiDefaults.ts's
// AI_CONTEXT_TEMPLATE / RELEVANCE_QUESTION_TEMPLATE, which name the
// association ("...for {name}."). This pair is the name-free last-resort
// fallback inside composeSystemInstruction() below, for a caller that supplies
// no aiContext at all. In practice that branch is unreachable from the bill
// pipeline: queue/processor.ts always resolves aiContext through
// buildDefaultAiContext (falling back to the association name placeholder,
// never to this constant) before calling into processBill. Keep this fallback
// text generic and keep the shared templates as the authoritative source of
// what tenants actually see — do not merge the two or delete this fallback.
export const DEFAULT_AI_CONTEXT = `You are analyzing a bill for a policy organization.

When writing the summary, start directly with an action verb or gerund phrase — do not begin with "This bill", "The bill", or the bill number (e.g. "Requires all counties to...", "Establishes a new procedure for...", "Prohibits local governments from..."). Be concise and proportional to the bill's complexity — a simple or narrow amendment warrants 1–2 sentences; a multi-part or substantive bill may warrant a short paragraph.`

export const DEFAULT_RELEVANCE_QUESTION = "Rate how relevant this bill is to the organization's legislative priorities."

/**
 * Renderer-format contract appended to every tenant's system instruction.
 * Governs HOW a list is formatted (not WHETHER to use one — that's editorial,
 * left to each tenant's ai_context). Matches what web/src/components/MarkdownSummary.tsx
 * parses cleanly and forbids the variants that don't (the "bullet" word, • glyph, HTML).
 */
export const SUMMARY_FORMAT_CONTRACT = `Formatting:
If you present multiple items as a list, format it as a Markdown unordered list: write each item on its own line beginning with a hyphen and a space ("- "). Use only "- " as the marker — never the "•" character, asterisks, numbers, HTML tags, or the literal word "bullet", and never put more than one item on a single line. If you include a lead-in sentence before the list, put it on its own line above the list. Otherwise write plain prose; you may use **bold** sparingly to flag a key term and use no other formatting.`

/** Compose the full system instruction: tenant editorial voice + universal format contract. */
export function composeSystemInstruction(aiContext: string | null | undefined): string {
  // Blank must behave as absent: fields are empty by default, so `??` alone
  // would send an empty editorial voice.
  const voice = (aiContext ?? '').trim().length > 0 ? aiContext : DEFAULT_AI_CONTEXT
  return `${voice}\n\n${SUMMARY_FORMAT_CONTRACT}`
}

function buildPrompt(
  billNumber: string,
  title: string,
  taxonomy: TaxonomyItem[],
  relevanceQuestion: string,
): string {
  const taxonomyLines = taxonomy
    .map(t => (t.description ? `- ${t.name}: ${t.description}` : `- ${t.name}`))
    .join('\n')
  return `Bill number: ${billNumber}
Title: ${title}

Your task:
1. List every statutory citation this bill affects, exactly as printed in the bill — the "Sections Affected" list near the top is usually the quickest place to find them. Do this before assigning tags.
2. Write a summary of this bill following your system instructions.
3. Assign tags from the list below. Where a tag carries a description, that description defines the test for that tag and overrides the general guidance in this step. For a tag with no description, assign it when the bill substantively addresses its topic — changes, regulates, funds, or establishes it — not for an incidental mention or shared procedure. Assigning no tags is correct only if none apply. Select only from this list:
${taxonomyLines}
4. ${relevanceQuestion} Give an integer 1–10. Anchor: 1 = no genuine connection to this subject (an incidental mention or shared procedure is not a connection); 5 = partially or indirectly bears on it; 10 = squarely and substantially about it. Judge by what the bill does, not surface keywords.`
}

function validateAndClamp(parsed: unknown): ProcessBillResult {
  const p = parsed as any
  if (typeof p.summary !== 'string' || !Array.isArray(p.tags) || typeof p.relevanceScore !== 'number') {
    throw new Error('Invalid response structure from AI provider')
  }
  return {
    summary: p.summary,
    tags: p.tags,
    relevanceScore: Math.min(10, Math.max(1, p.relevanceScore)),
    // Absent or malformed citations are not a failed analysis: the summary,
    // tags and score are the contract, and this field is supplementary. A
    // non-array degrades to empty rather than throwing away a good analysis.
    affectedCitations: Array.isArray(p.affectedCitations)
      ? p.affectedCitations.filter((c: unknown): c is string => typeof c === 'string' && c.trim().length > 0)
      : [],
  }
}

// ── Gateway-routed Gemini ─────────────────────────────────────────────────────

/**
 * Analysis model and thinking budget.
 *
 * Both are overridable per environment so one tenant can move ahead of the
 * fleet. The model is an operator decision about cost and quality, so it lives
 * in wrangler vars rather than in tenant-editable config.
 *
 * The DEFAULTS ARE THE INCUMBENT CONFIGURATION, deliberately. A measured
 * comparison on 103 bills with ground truth (2026-09-05) scoring tags whose
 * criterion is mechanical rather than topical:
 *
 *   gemini-2.5-flash, no thinking    25% precision  1.0x cost  <- this default
 *   gemini-2.5-flash, thinking       33% precision  2.5x
 *   gemini-3.5-flash, no thinking    75% precision  7.8x
 *   gemini-3.1-flash-lite, thinking 100% precision  2.3x
 *   gemini-3.5-flash-lite, thinking 100% precision  3.4x
 *   gemini-3.8-flash, thinking      100% precision  6.9x
 *   gemini-3.5-flash, thinking      100% precision 13.7x
 *
 * Every current-generation model tested reaches 100%, so among those the choice
 * is price, not capability — do not reach for the biggest one. Cost multiples
 * are per bill against this default; the 3.x models tokenise the same PDF at
 * roughly double the input tokens, and thinking tokens bill as output.
 *
 * The default is still the old model because the failure this fixes has only
 * been observed on mechanical tags, which one tenant uses. Raising the cost of
 * every tenant's every bill to fix a problem one tenant has is not a trade this
 * default gets to make silently.
 *
 * Flip this once the cost question is settled — it is one line, and the tenant
 * already running the newer model is the evidence for whether it regresses
 * ordinary topical tagging.
 *
 * Two results that read as surprising and are not: thinking on the older model
 * is not a fix, and model generation matters more than thinking does. Do not
 * re-tune either default from a small sample — a 12-bill screen put the old
 * model at 100%, and the 103-bill run put the same configuration at 33%.
 */
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'

/** -1 asks Gemini to size the thinking budget itself; 0 disables thinking. */
const DEFAULT_THINKING_BUDGET = 0

function resolveModel(env: Env): string {
  const configured = (env.GEMINI_MODEL ?? '').trim()
  return configured.length > 0 ? configured : DEFAULT_GEMINI_MODEL
}

/** Blank or unparseable falls back to the default rather than silently disabling thinking. */
function resolveThinkingBudget(env: Env): number {
  const raw = (env.GEMINI_THINKING_BUDGET ?? '').trim()
  if (raw.length === 0) return DEFAULT_THINKING_BUDGET
  const n = Number(raw)
  return Number.isInteger(n) ? n : DEFAULT_THINKING_BUDGET
}

async function callGemini(
  params: ProcessBillParams,
  env: Env,
  tier: 'flex' | 'standard' | 'priority',
): Promise<ProcessBillResult> {
  const useGateway = env.AI_GATEWAY_ENABLED === 'true'
  if (useGateway && (!env.CF_ACCOUNT_ID || !env.CF_AIG_GATEWAY || !env.CF_AIG_TOKEN)) {
    throw new Error('AI_GATEWAY_ENABLED is true but CF_ACCOUNT_ID, CF_AIG_GATEWAY, or CF_AIG_TOKEN is missing')
  }

  const promptText = buildPrompt(
    params.billNumber,
    params.title,
    params.taxonomy,
    params.relevanceQuestion ?? DEFAULT_RELEVANCE_QUESTION,
  )

  const client = new GoogleGenAI({
    apiKey: useGateway ? (env.CF_AIG_TOKEN ?? 'keyless') : (env.GEMINI_API_KEY ?? ''),
    ...(useGateway ? {
      httpOptions: {
        baseUrl: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AIG_GATEWAY}/google-ai-studio`,
        headers: {
          'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}`,
          'cf-aig-metadata': JSON.stringify({ tenantId: env.TENANT_ID }),
          'x-goog-api-key': '', // empty: prevents SDK adding real key; CF treats absent/empty key as wholesale
        },
      },
    } : {}),
  })

  const parts = params.pdfBase64
    ? [
        { inlineData: { mimeType: 'application/pdf', data: params.pdfBase64 } },
        { text: promptText },
      ]
    : [{ text: `${promptText}\n\nFull text:\n${params.text}` }]

  const response = await client.models.generateContent({
    model: resolveModel(env),
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: composeSystemInstruction(params.aiContext),
      responseMimeType: 'application/json',
      responseSchema: buildAnalysisSchema(params.taxonomy),
      thinkingConfig: { thinkingBudget: resolveThinkingBudget(env) },
      serviceTier: ({ flex: ServiceTier.FLEX, standard: ServiceTier.STANDARD, priority: ServiceTier.PRIORITY } as const)[tier],
    },
  })

  const raw = response.text
  if (!raw) throw new Error('Gemini returned an empty response')
  return validateAndClamp(JSON.parse(raw))
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function processBill(
  params: ProcessBillParams,
  env: Env,
  tier: 'flex' | 'standard' | 'priority' = 'flex',
): Promise<ProcessBillResult> {
  return await callGemini(params, env, tier)
}
