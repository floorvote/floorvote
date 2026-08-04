import { Hono } from 'hono'
import { eq, asc } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth'
import { getDb } from '../db/client'
import { associationConfig, customFieldDefinitions } from '../db/schema'
import { ensureInstancePreset } from '../lib/instancePreset'
import { getAccountDeletionEnabled } from '../lib/accountDeletion'
import { loadEffectiveTaxonomy } from '../lib/taxonomy'
import { centralFetch } from '../lib/centralFetch'
import { isSuperadminRequest } from '../lib/superadminRequest'
import { resolveOrgNoun } from '../../../shared/orgNoun'
import { PRODUCT_NAME } from '../../../shared/brand'
import { parseEmailList } from '../../../shared/operator'
import type { AppEnv } from '../types'

export const configRouter = new Hono<AppEnv>()

function safeJsonParse(raw: string | null): string[] | null {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

// Whether the UI should show per-bill state labels, derived from coverage intent.
// STATE-scoped instance ⇒ always single-state. A STATE="" instance with no coverage
// row — or an unparseable one — is treated as wildcard ("*"), matching
// registerWithCentral (api/src/cron/sync.ts), which defaults missing coverage to ['*'].
export function computeMultiState(state: string | undefined, coverageRaw: string | undefined): boolean {
  if (state) return false
  if (coverageRaw == null) return true
  let coverage: string[]
  try {
    coverage = JSON.parse(coverageRaw) as string[]
  } catch {
    return true // unparseable coverage ⇒ same "unknown" default as a missing row
  }
  return coverage.includes('*') || coverage.length > 1
}

configRouter.use('*', requireAuth)

const DEFAULT_ASSOCIATION_NAME = PRODUCT_NAME
const DEFAULT_POSITION_VOCABULARY = ['Support', 'Oppose', 'Amend', 'Monitor', 'No Position']

// GET /config — public (auth required, not admin)
configRouter.get('/', async (c) => {
  const db = getDb(c.env.DB)
  await ensureInstancePreset(c.env, db)
  const accountDeletionEnabled = await getAccountDeletionEnabled(db)

  const [nameRow, sessionsRow, posLabelRow, coverageRow, posVocabRow, modulesRow, orgNounRow, taxonomyItems] = await Promise.all([
    db.select().from(associationConfig).where(eq(associationConfig.key, 'association_name')).get(),
    db.select().from(associationConfig).where(eq(associationConfig.key, 'sessions')).get(),
    db.select().from(associationConfig).where(eq(associationConfig.key, 'position_label')).get(),
    db.select().from(associationConfig).where(eq(associationConfig.key, 'state_coverage')).get(),
    db.select().from(associationConfig).where(eq(associationConfig.key, 'position_vocabulary')).get(),
    db.select().from(associationConfig).where(eq(associationConfig.key, 'modules')).get(),
    db.select().from(associationConfig).where(eq(associationConfig.key, 'org_noun')).get(),
    loadEffectiveTaxonomy(db),
  ])

  let associationName: string
  if (nameRow) {
    try {
      associationName = JSON.parse(nameRow.value) as string
    } catch {
      associationName = nameRow.value
    }
  } else if (c.env.ASSOCIATION_NAME) {
    associationName = c.env.ASSOCIATION_NAME
  } else {
    associationName = DEFAULT_ASSOCIATION_NAME
  }

  const positionVocabulary: string[] = safeJsonParse(posVocabRow?.value ?? null) ?? DEFAULT_POSITION_VOCABULARY

  type NormalizedSession = {
    identifier: string
    name: string
    classification: string
    startDate: string
    endDate: string
  }
  type SessionsCache = { data: NormalizedSession[]; cachedAt: string }
  const SESSION_TTL_MS = 24 * 60 * 60 * 1000
  let sessions: NormalizedSession[] = []
  let shouldRefreshSessions = false
  if (sessionsRow) {
    try {
      const parsed = JSON.parse(sessionsRow.value) as SessionsCache | NormalizedSession[]
      if (Array.isArray(parsed)) {
        // Legacy format — missing cachedAt, force refresh
        sessions = parsed
        shouldRefreshSessions = true
      } else {
        sessions = parsed.data
        shouldRefreshSessions = Date.now() - new Date(parsed.cachedAt).getTime() > SESSION_TTL_MS
      }
    } catch {
      sessions = []
      shouldRefreshSessions = true
    }
  } else {
    shouldRefreshSessions = true
  }

  if (shouldRefreshSessions && c.env.STATE && c.env.CENTRAL_API_URL) {
    // Sessions stale or missing — fetch from central and cache for 24h
    try {
      const res = await centralFetch(c.env, `/bills/sessions?state=${c.env.STATE}`)
      if (res.ok) {
        const data = await res.json<{ sessions: NormalizedSession[] }>()
        sessions = data.sessions ?? []
        if (sessions.length > 0) {
          const cache: SessionsCache = { data: sessions, cachedAt: new Date().toISOString() } // ts-write-ok: cache metadata inside a JSON config blob, never SQL-sorted
          await db.insert(associationConfig)
            .values({ key: 'sessions', value: JSON.stringify(cache) })
            .onConflictDoUpdate({ target: associationConfig.key, set: { value: JSON.stringify(cache) } })
        }
      } else {
        console.error(`[config] central sessions returned ${res.status}: ${await res.text().catch(() => '(no body)')}`)
      }
    } catch (err) {
      console.error('[config] central sessions fetch failed:', err)
    }
  }

  // Derive covered states
  let states: string[] = []
  if (c.env.STATE) {
    states = [c.env.STATE]
  } else if (coverageRow) {
    try {
      states = JSON.parse(coverageRow.value) as string[]
    } catch {
      states = []
    }
  }

  const multiState = computeMultiState(c.env.STATE, coverageRow?.value)

  const orgNoun = resolveOrgNoun(
    orgNounRow?.value ? JSON.parse(orgNounRow.value) as string : null,
    posLabelRow?.value ? JSON.parse(posLabelRow.value) as string : null,
  )

  let instanceDomains: Record<string, string> = {}
  if (c.env.INSTANCE_DOMAINS) {
    try {
      instanceDomains = JSON.parse(c.env.INSTANCE_DOMAINS) as Record<string, string>
    } catch {
      console.error('[config] invalid INSTANCE_DOMAINS JSON')
    }
  }

  const demoMode = c.env.DEMO_MODE === 'true'
  const currentUser = c.get('user')
  const demoLocked = demoMode && !(await isSuperadminRequest(c))

  // Modules can be `Record<string, boolean>` (legacy) or
  // `Record<string, { enabled: boolean, settings?: Record<string, unknown> }>` (new).
  // Pass through opaquely — clients handle both shapes.
  let modules: Record<string, unknown> = {}
  if (modulesRow) {
    try {
      const parsed = JSON.parse(modulesRow.value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        modules = parsed as Record<string, unknown>
      }
    } catch {
      // malformed JSON — fall through with modules = {}
    }
  }

  const operator = {
    name: c.env.OPERATOR_NAME ?? '',
    url: c.env.OPERATOR_URL ?? '',
    contactEmails: parseEmailList(c.env.OPERATOR_CONTACT_EMAILS),
  }

  const tagTaxonomy = taxonomyItems.map(t => t.name)

  return c.json({ associationName, positionVocabulary, state: c.env.STATE ?? '', states, multiState, sessions, orgNoun, instanceDomains, demoMode, demoLocked, modules, operator, accountDeletionEnabled, tagTaxonomy })
})

// GET /config/sessions?state=NJ — per-state session list, proxied from central
configRouter.get('/sessions', async (c) => {
  const state = c.req.query('state')
  if (!state) return c.json({ error: 'state is required' }, 400)
  try {
    const res = await centralFetch(c.env, `/bills/sessions?state=${state}`)
    if (!res.ok) {
      console.error(`[config/sessions] central returned ${res.status}: ${await res.text().catch(() => '(no body)')}`)
      return c.json({ sessions: [] })
    }
    return c.json(await res.json())
  } catch (err) {
    console.error('[config/sessions] central fetch failed:', err)
    return c.json({ sessions: [] })
  }
})

// GET /config/custom-fields — public (authenticated) list of field definitions
configRouter.get('/custom-fields', async (c) => {
  const db = getDb(c.env.DB)
  const fields = await db
    .select()
    .from(customFieldDefinitions)
    .orderBy(asc(customFieldDefinitions.displayOrder))
    .all()
  return c.json(fields.map(f => ({
    ...f,
    options: safeJsonParse(f.options),
  })))
})
