import { stripHtml, truncateWithEllipsis, COMMENT_PREVIEW_MAX } from '../../../../../shared/feedUtils'
import type { DemoSeed, DemoSeedFeedEvent } from '../types'
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
 * duplicated. The NJ seed hand-writes these, which is why its feed showed a
 * single comment per card and why a preview could drift from its comment.
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
      id: `lm-fe-v-${externalId.replace('legiscan:', '')}`,
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
}
