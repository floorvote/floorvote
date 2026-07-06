import { dbTsToEpoch } from '../../../shared/time'

// Re-export under the historical name so existing importers
// (FeedUnreadContext, time.test.ts) are untouched.
export const feedTsToEpoch = dbTsToEpoch

export function relativeTime(iso: string): string {
  const ms = Date.now() - dbTsToEpoch(iso)
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return minutes <= 1 ? 'Just now' : `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'Yesterday' : `${days}d ago`
}

// A feed item (row) is "unread" — and gets a blue dot — when it happened after
// the user's last Feed visit AND wasn't done by the user themselves. Your own
// actions never dot. `seenAt` null (never visited) shows no dots.
export function isUnreadItem(
  itemCreatedAt: string,
  itemUserId: string | null,
  seenAt: string | null,
  currentUserId: string | null,
): boolean {
  if (seenAt === null) return false
  if (currentUserId !== null && itemUserId === currentUserId) return false
  return feedTsToEpoch(itemCreatedAt) > feedTsToEpoch(seenAt)
}

export function absoluteTime(iso: string): string {
  return new Date(dbTsToEpoch(iso)).toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}
