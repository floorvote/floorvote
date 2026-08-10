import type { TaxonomyItem } from '../taxonomy'

/**
 * The data half of a demo reset. Everything here is inert description — all
 * SQL, truncate ordering, and FK handling lives in demoReset.ts.
 *
 * Day offsets are positive integers meaning "N days ago" unless the field name
 * says otherwise; the machinery converts them with the SQLite space format that
 * stored timestamps require (see docs/internal/dates.md).
 */
export type DemoSeedUser = {
  id: string
  email: string
  name: string
  role: 'owner' | 'admin' | 'member'
  subtitle: string
  createdDaysAgo: number
  canVote: boolean
  /** Drives sessions.last_active and magic_links.used_at, which the sidebar
   *  member count and the admin active-member stats both read. */
  lastActiveDaysAgo: number
}

export type DemoSeedRole = { id: string; name: string }

export type DemoSeedCustomField = {
  id: string
  name: string
  slug: string
  type: 'dropdown' | 'text' | 'date' | 'binary'
  options: string[] | null
  displayOrder: number
  pinned?: boolean
}

export type DemoSeedComment = {
  id: string
  externalId: string
  userId: string
  /** Sanitized HTML, including span[data-type=mention] markup for @mentions. */
  content: string
  daysAgo: number
}

export type DemoSeedReaction = {
  id: string
  commentId: string
  userId: string
  /** Single emoji character, e.g. '👍'. */
  emoji: string
  daysAgo: number
}

export type DemoSeedMention = {
  id: string
  commentId: string
  userId: string
  sourceType: 'user' | 'role'
  sourceId: string
  daysAgo: number
}

export type DemoSeedFeedEvent = {
  id: string
  type: 'priority_set' | 'position_set' | 'comment_added' | 'vote_milestone' | 'bill_updated'
  externalId: string
  userId: string
  metadata: Record<string, unknown>
  daysAgo: number
}

export type DemoSeedCalendarEvent = {
  id: string
  externalId: string | null
  source: 'hearing' | 'custom'
  /** Negative for past events. */
  offsetDays: number
  time: string | null
  location: string | null
  description: string
}

/**
 * One entry in a seed's `modules` map, keyed by module id ('calendar',
 * 'email-digest', 'waiting-for-vote', 'upcoming-hearings'). A bare boolean is the
 * legacy shape and still valid; the object shape carries per-module settings.
 * Written verbatim to association_config.modules, which GET /config passes through
 * opaquely because both shapes are live in the field.
 */
export type DemoSeedModule = boolean | { enabled: boolean; settings?: Record<string, unknown> }

/**
 * One legislative session, matching the shape GET /config caches under
 * association_config.sessions (`NormalizedSession` in routes/configApi.ts). Dates
 * are date-only `YYYY-MM-DD` and absolute, not offsets — a session's span is a
 * fact about the legislature, not something that should slide with the reset date.
 */
export type DemoSeedSession = {
  identifier: string
  name: string
  classification: string
  startDate: string
  endDate: string
}

export type DemoSeed = {
  slug: string
  /** Rendered with the `Demo — ` prefix applied by the machinery. */
  associationName: string
  /** Rendered verbatim in the dismissible demo banner (App.tsx's DemoBanner). */
  bannerText: string
  orgNoun: string
  aiContext: string
  relevanceQuestion: string
  /** Feeds the AI tagging pipeline — the tag list the model must choose from. */
  tagTaxonomy: TaxonomyItem[]
  keywords: string[]
  positionVocabulary: string[]
  /** Module id → enabled flag or `{ enabled, settings }`. See DemoSeedModule. */
  modules: Record<string, DemoSeedModule>
  /** Written to association_config.sessions; the machinery adds the `cachedAt`
   *  that the cache format also carries. See DemoSeedSession. */
  sessions: { data: DemoSeedSession[] }
  /** State coverage for a multi-state tenant; null for a STATE-scoped one. */
  stateCoverage: string[] | null

  users: DemoSeedUser[]
  roles: DemoSeedRole[]
  userRoles: Array<{ userId: string; roleId: string }>
  customFields: DemoSeedCustomField[]

  priorities: Array<{ externalId: string; priority: 'high' | 'medium' | 'low' }>
  positions: Array<{ id: string; externalId: string; position: string; setBy: string; daysAgo: number }>
  votes: Array<{ id: string; externalId: string; userId: string; position: string; daysAgo: number }>
  comments: DemoSeedComment[]
  reactions: DemoSeedReaction[]
  mentions: DemoSeedMention[]
  feedEvents: DemoSeedFeedEvent[]
  customFieldValues: Array<{ externalId: string; fieldId: string; value: string; setBy: string; daysAgo: number }>
  notes: Array<{ id: string; externalId: string; content: string; daysAgo: number }>
  calendarEvents: DemoSeedCalendarEvent[]
}
