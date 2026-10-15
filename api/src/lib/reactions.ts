// Reaction notifications: reacting to a comment notifies its author, in the app
// only. Reactions are never emailed.
//
// One row per comment, reactor, and emoji, stored through writeNotifications.
// The unique index (migration 0089) is what makes a repeat write a no-op, so a
// removed reaction that is added back does not notify the author twice. Removing
// a reaction leaves its notification in place. The panel collapses a comment's
// rows into one (lib/notifications.ts).
import type { getDb } from '../db/client'
import { writeNotifications } from './notifications'

type Db = ReturnType<typeof getDb>

export async function notifyAuthorOfReaction(
  db: Db,
  comment: { id: string; billId: string; userId: string },
  reactorId: string,
  emoji: string,
): Promise<void> {
  // Reacting to your own comment tells you nothing.
  if (comment.userId === reactorId) return
  await writeNotifications(db, [{
    recipientId: comment.userId,
    kind: 'reaction',
    billId: comment.billId,
    commentId: comment.id,
    actorId: reactorId,
    data: { emoji },
  }])
}
