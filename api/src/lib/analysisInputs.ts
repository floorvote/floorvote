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
 *
 * `textDocId` and `textHash` name the document central served, which is the one
 * the model reads, so claim sources can be pinned to it (#568). Both are null
 * when the model reads the title and abstract, and when an older central sends
 * neither field. A value of the wrong type is treated as absent.
 */
export async function loadBillTextForAi(
  env: Env,
  billId: string,
  bill: { number: string; title: string; abstract: string | null },
): Promise<{ billText: string; billPdfBase64: string | undefined; hasFullText: boolean; textDocId: string | null; textHash: string | null }> {
  let billText = `${bill.title}. ${bill.abstract ?? ''}`
  let billPdfBase64: string | undefined
  let hasFullText = false
  let textDocId: string | null = null
  let textHash: string | null = null
  try {
    const textRes = await centralFetch(env, `/bills/${billId}/text`)
    if (textRes.ok) {
      const textData = await textRes.json() as { type: 'html' | 'pdf'; content: string; docId?: unknown; textHash?: unknown }
      if (textData.type === 'pdf') billPdfBase64 = textData.content
      else billText = billHtmlToText(textData.content)
      hasFullText = true
      textDocId = readDocId(textData.docId)
      textHash = typeof textData.textHash === 'string' && textData.textHash.length > 0 ? textData.textHash : null
    } else if (textRes.status !== 404) {
      console.error(`[processor] central text returned ${textRes.status} for ${bill.number}`)
    }
  } catch (err) {
    console.error(`[processor] failed to fetch text for ${bill.number}:`, err)
  }
  // No hash without the document it belongs to.
  if (textDocId === null) textHash = null
  return { billText, billPdfBase64, hasFullText, textDocId, textHash }
}

/** A doc id as instances store them: a non-empty string. Central sends a string, and a whole number is read as one. */
function readDocId(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.length > 0 ? raw : null
  if (typeof raw === 'number' && Number.isInteger(raw)) return String(raw)
  return null
}
