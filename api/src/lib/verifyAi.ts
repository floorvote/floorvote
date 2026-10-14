import { centralFetch } from './centralFetch'
import { loadAnalysisInputs, loadBillTextForAi } from './analysisInputs'
import { processBill } from './llm'
import type { AppDb, Env } from '../types'

export type VerifyAiResult =
  | { status: 'ok'; billNumber: string; tags: number; relevanceScore: number; usedFullText: boolean }
  | { status: 'skipped'; reason: string }

/**
 * Analyze one stored bill end to end for scripts/verify-instance.sh: read it
 * from central, build the prompt from the instance's own AI settings, and call
 * the model through the same path the queue consumer uses.
 *
 * Writes nothing. The pipeline's result lands on a bill row, which would leave a
 * bill the organization never chose to track; this returns the result instead.
 * It costs one model call.
 *
 * A failure is thrown, message intact, so the operator sees the provider's own
 * words (a depleted credit balance and a bad token read very differently).
 * Only "no AI configured at all" is a skip.
 */
export async function verifyAi(env: Env, db: AppDb, billId: string): Promise<VerifyAiResult> {
  if (env.DEMO_MODE === 'true') {
    return { status: 'skipped', reason: 'this is a demo instance, which never calls the model' }
  }
  if (env.AI_GATEWAY_ENABLED !== 'true' && !env.GEMINI_API_KEY) {
    return { status: 'skipped', reason: 'no AI is configured (AI_GATEWAY_ENABLED is not "true" and GEMINI_API_KEY is not set)' }
  }

  const res = await centralFetch(env, `/bills/${billId}`)
  if (!res.ok) throw new Error(`Central API returned ${res.status} for bill ${billId}`)
  const bill = await res.json() as { number: string; title: string; abstract: string | null }

  const { aiContext, relevanceQuestion, taxonomy } = await loadAnalysisInputs(db)
  const { billText, billPdfBase64, hasFullText } = await loadBillTextForAi(env, billId, bill)

  // Standard tier, not the queue's flex: flex sheds under load and the pipeline
  // retries it later, but a check that fails on a shed would report a healthy
  // deployment as broken.
  const result = await processBill(
    { billNumber: bill.number, title: bill.title, text: billText, pdfBase64: billPdfBase64, taxonomy, aiContext, relevanceQuestion },
    env,
    'standard',
  )
  return { status: 'ok', billNumber: bill.number, tags: result.tags.length, relevanceScore: result.relevanceScore, usedFullText: hasFullText }
}
