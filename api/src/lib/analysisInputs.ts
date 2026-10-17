import { eq } from 'drizzle-orm'
import { associationConfig } from '../db/schema'
import { centralFetch } from './centralFetch'
import { billHtmlToText } from './billText'
import { readConfigString } from './configValue'
import { DEFAULT_TAXONOMY, parseTaxonomyItems, type TaxonomyItem } from './taxonomy'
import {
  ASSOCIATION_NAME_PLACEHOLDER,
  buildDefaultAiContext,
  buildDefaultRelevanceQuestion,
  isAiConfigDefault,
} from '../../../shared/aiDefaults'
import { legacyHandle } from '../../../shared/billHandle'
import type { AppDb, Env } from '../types'

// What one bill analysis is given, shared by the queue consumer and by
// scripts/verify-instance.sh's AI check (lib/verifyAi.ts) so the check exercises
// the same inputs the pipeline does.

/** The instance's AI context, relevance question, and tag taxonomy, defaults resolved. */
export async function loadAnalysisInputs(db: AppDb): Promise<{
  aiContext: string | undefined
  relevanceQuestion: string | undefined
  taxonomy: TaxonomyItem[]
}> {
  const [aiContextRow, taxonomyRow, relevanceQuestionRow, nameRow] = await Promise.all([
    db.select().from(associationConfig).where(eq(associationConfig.key, 'ai_context')).get(),
    db.select().from(associationConfig).where(eq(associationConfig.key, 'tag_taxonomy')).get(),
    db.select().from(associationConfig).where(eq(associationConfig.key, 'relevance_question')).get(),
    db.select().from(associationConfig).where(eq(associationConfig.key, 'association_name')).get(),
  ])
  // Resolve here rather than relying on downstream `??` fallbacks: the fields are
  // empty by default, and the defaults interpolate the association name so a
  // rename is reflected on the next prompt with no stored state to migrate.
  const associationName = readConfigString(nameRow) ?? ASSOCIATION_NAME_PLACEHOLDER
  const storedAiContext = readConfigString(aiContextRow)
  const storedRelevanceQuestion = readConfigString(relevanceQuestionRow)
  const aiContext = isAiConfigDefault(storedAiContext)
    ? buildDefaultAiContext(associationName)
    : storedAiContext
  const relevanceQuestion = isAiConfigDefault(storedRelevanceQuestion)
    ? buildDefaultRelevanceQuestion(associationName)
    : storedRelevanceQuestion
  const dbTaxonomy = taxonomyRow ? parseTaxonomyItems(JSON.parse(taxonomyRow.value)) : []
  const taxonomy = dbTaxonomy.length > 0 ? dbTaxonomy : DEFAULT_TAXONOMY
  return { aiContext, relevanceQuestion, taxonomy }
}

/**
 * The text the model reads for a bill: the full document from central, or the
 * title and abstract when central has none. `hasFullText` says which.
 */
export async function loadBillTextForAi(
  env: Env,
  billId: string,
  bill: { number: string; title: string; abstract: string | null },
): Promise<{ billText: string; billPdfBase64: string | undefined; hasFullText: boolean }> {
  let billText = `${bill.title}. ${bill.abstract ?? ''}`
  let billPdfBase64: string | undefined
  let hasFullText = false
  try {
    const textRes = await centralFetch(env, `/bills/${legacyHandle(billId)}/text`)
    if (textRes.ok) {
      const textData = await textRes.json() as { type: 'html' | 'pdf'; content: string }
      if (textData.type === 'pdf') billPdfBase64 = textData.content
      else billText = billHtmlToText(textData.content)
      hasFullText = true
    } else if (textRes.status !== 404) {
      console.error(`[processor] central text returned ${textRes.status} for ${bill.number}`)
    }
  } catch (err) {
    console.error(`[processor] failed to fetch text for ${bill.number}:`, err)
  }
  return { billText, billPdfBase64, hasFullText }
}
