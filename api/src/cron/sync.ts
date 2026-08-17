import { eq } from 'drizzle-orm'
import { associationConfig } from '../db/schema'
import { ensureAssociationName } from '../lib/associationName'
import { centralFetch } from '../lib/centralFetch'
import { readConfigString } from '../lib/configValue'
import { isAiConfigDefault } from '../../../shared/aiDefaults'
import type { AppDb, Env } from '../types'

export async function registerWithCentral(env: Env, db: AppDb): Promise<boolean> {
  await ensureAssociationName(env, db)
  const [keywordsRow, stateCoverageRow, aiContextRow] = await Promise.all([
    db.select().from(associationConfig).where(eq(associationConfig.key, 'keywords')).get(),
    db.select().from(associationConfig).where(eq(associationConfig.key, 'state_coverage')).get(),
    db.select().from(associationConfig).where(eq(associationConfig.key, 'ai_context')).get(),
  ])

  const keywords: string[] = keywordsRow ? JSON.parse(keywordsRow.value) : []
  const stateCoverage: string[] = stateCoverageRow
    ? JSON.parse(stateCoverageRow.value)
    : (env.STATE ? [env.STATE] : ['*'])

  const body = {
    tenantId: env.TENANT_ID,
    name: env.ASSOCIATION_NAME ?? env.TENANT_ID,
    apiUrl: env.APP_URL,
    stateCoverage,
    keywords,
    aiContextPersonalized: !isAiConfigDefault(readConfigString(aiContextRow)),
  }

  try {
    const res = await centralFetch(env, '/tenants/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      console.error(`Central registration failed: HTTP ${res.status}`)
      return false
    }
    return true
  } catch (err) {
    console.error('Central registration error:', err)
    return false
  }
}
