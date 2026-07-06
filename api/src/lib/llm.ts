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
}

// ── Shared constants ──────────────────────────────────────────────────────────

const BILL_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    relevanceScore: { type: 'integer', description: 'An integer from 1 to 10 inclusive.' },
  },
  required: ['summary', 'tags', 'relevanceScore'],
  additionalProperties: false,
} as const

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
  return `${aiContext ?? DEFAULT_AI_CONTEXT}\n\n${SUMMARY_FORMAT_CONTRACT}`
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
1. Write a summary of this bill following your system instructions.
2. Assign every tag whose topic the bill substantively addresses — changes, regulates, funds, or establishes it. Apply a tag for genuine subject matter, not an incidental mention or shared procedure. Assigning no tags is correct only if none genuinely apply. Select only from this list:
${taxonomyLines}
3. ${relevanceQuestion} Give an integer 1–10. Anchor: 1 = no genuine connection to this subject (an incidental mention or shared procedure is not a connection); 5 = partially or indirectly bears on it; 10 = squarely and substantially about it. Judge by what the bill does, not surface keywords.`
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
  }
}

// ── Gateway-routed Gemini ─────────────────────────────────────────────────────

const GEMINI_MODEL = 'gemini-2.5-flash'

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
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: composeSystemInstruction(params.aiContext),
      responseMimeType: 'application/json',
      responseSchema: BILL_ANALYSIS_SCHEMA,
      thinkingConfig: { thinkingBudget: 0 },
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
