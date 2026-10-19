import { stripHtml, truncateWithEllipsis, COMMENT_PREVIEW_MAX } from '../../../../../shared/feedUtils'
import type { DemoSeed, DemoSeedFeedEvent } from '../types'
import { viewQuery } from '../viewQuery'
import { parseHandle } from '../../../../../shared/billHandle'
import { LM_ORG } from './org'
import { LM_CUSTOM_FIELDS, LM_ROLES, LM_USER_ROLES, LM_USERS } from './roster'
import {
  LM_BILL_UPDATED_EVENTS,
  LM_RECENT_ACTIVITY_EVENTS,
  LM_CALENDAR_EVENTS,
  LM_CUSTOM_FIELD_VALUES,
  LM_ENGAGEMENT_EVENTS,
  LM_HEARING_EVENTS,
  LM_POSITIONS,
  LM_PRIORITIES,
} from './bills'
import { LM_COMMENTS, LM_MENTIONS, LM_NOTES, LM_REACTIONS, LM_VOTES } from './discussion'

/**
 * One comment_added event per comment, with the preview derived rather than
 * duplicated, so a preview cannot drift from its comment.
 */
const commentEvents: DemoSeedFeedEvent[] = LM_COMMENTS.map((c) => {
  const mentioned = LM_MENTIONS.filter(m => m.commentId === c.id).map(m => m.userId)
  return {
    // `lm-c-12` → `lm-fe-c-12`, rather than the doubled `lm-fe-c-lm-c-12`.
    id: `lm-fe-c-${c.id.replace(/^lm-c-/, '')}`,
    type: 'comment_added' as const,
    externalId: c.externalId,
    userId: c.userId,
    metadata: {
      commentId: c.id,
      preview: truncateWithEllipsis(stripHtml(c.content), COMMENT_PREVIEW_MAX),
      ...(mentioned.length ? { mentionedUserIds: mentioned } : {}),
    },
    daysAgo: c.daysAgo,
  }
})

/** A milestone once a bill draws 4+ member votes, dated to the newest of them. */
const voteMilestones: DemoSeedFeedEvent[] = Object.entries(
  LM_VOTES.reduce<Record<string, typeof LM_VOTES>>((acc, v) => {
    (acc[v.externalId] ??= []).push(v)
    return acc
  }, {}),
)
  .filter(([, vs]) => vs.length >= 4)
  .map(([externalId, vs]) => {
    const newest = vs.reduce((a, b) => (a.daysAgo <= b.daysAgo ? a : b))
    return {
      id: `lm-fe-v-${parseHandle(externalId)}`,
      type: 'vote_milestone' as const,
      externalId,
      userId: newest.userId,
      metadata: { message: `${vs.length} members have voted on this bill` },
      daysAgo: newest.daysAgo,
    }
  })

export const LAKE_MICHIGAN_SEED: DemoSeed = {
  slug: 'lake-michigan',
  ...LM_ORG,
  users: LM_USERS, roles: LM_ROLES, userRoles: LM_USER_ROLES, customFields: LM_CUSTOM_FIELDS,
  priorities: LM_PRIORITIES, positions: LM_POSITIONS, votes: LM_VOTES,
  comments: LM_COMMENTS, reactions: LM_REACTIONS, mentions: LM_MENTIONS,
  feedEvents: [
    ...LM_BILL_UPDATED_EVENTS, ...LM_RECENT_ACTIVITY_EVENTS, ...LM_HEARING_EVENTS, ...LM_ENGAGEMENT_EVENTS,
    ...commentEvents, ...voteMilestones,
  ],
  customFieldValues: LM_CUSTOM_FIELD_VALUES, notes: LM_NOTES,
  calendarEvents: LM_CALENDAR_EVENTS,
  teamFieldChanges: [],
  // Written for a basin-wide water team. Each view combines filters the way a team
  // would, and they lean on what this seed writes (working group, position, priority)
  // so they return bills whatever the AI tagged. None uses a subject, since a demo
  // may hide them. The first is the one OR view, joining tags with a working group:
  // the drinking-water themes, or anything the Contaminants group owns. Counts are
  // for the 20 bills above.
  savedViews: [
    {
      // 8 bills: 6 tagged Drinking Water or Lead Service Lines, plus WI AB131 and IL HB2516 (Contaminants).
      id: 'lm-view-water-supply-or-contaminants', name: 'Drinking water or contaminants', slug: 'drinking-water-or-contaminants',
      query: viewQuery([
        ['match', 'any'], ['tag', 'Drinking Water'], ['tag', 'Lead Service Lines'], ['field.working-group', 'Contaminants'],
      ]),
    },
    {
      // 3 bills: MI HB4768, MI HB5674, and IL HB5268, which the Infrastructure group owns and no one has taken a position on.
      id: 'lm-view-infrastructure-open', name: 'Infrastructure bills with no position', slug: 'infrastructure-bills-with-no-position',
      query: viewQuery([['field.working-group', 'Infrastructure'], ['position', 'none']]),
    },
    {
      // 5 bills: MI HB4427, HB5308, SB0771, and WI AB131, SB56.
      id: 'lm-view-high-mi-wi', name: 'High priority in Michigan and Wisconsin', slug: 'high-priority-in-michigan-and-wisconsin',
      query: viewQuery([['priority', 'high'], ['state', 'MI'], ['state', 'WI']]),
    },
  ],
}
