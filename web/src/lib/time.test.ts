import { describe, it, expect } from 'vitest'
import { feedTsToEpoch, isUnreadItem, relativeTime, absoluteTime } from './time'

describe('feedTsToEpoch', () => {
  it('parses ISO-8601 (last_seen_feed) as UTC', () => {
    expect(feedTsToEpoch('2026-06-06T14:00:00.000Z')).toBe(Date.UTC(2026, 5, 6, 14, 0, 0))
  })

  it('parses SQLite datetime("now") space format as UTC', () => {
    // feed_events.created_at has no T and no Z but is UTC
    expect(feedTsToEpoch('2026-06-06 14:00:00')).toBe(Date.UTC(2026, 5, 6, 14, 0, 0))
  })

  it('compares a same-day event against last-seen correctly (the dot bug)', () => {
    // Event 1h after last visit, same calendar day. Naive string compare fails here
    // because " " (0x20) < "T" (0x54); epoch comparison must say event is newer.
    const event = '2026-06-06 14:00:00' // space format from DB
    const lastSeen = '2026-06-06T13:00:00.000Z' // ISO format
    expect(feedTsToEpoch(event) > feedTsToEpoch(lastSeen)).toBe(true)
  })

  it('treats an event before last-seen on the same day as not newer', () => {
    const event = '2026-06-06 12:00:00'
    const lastSeen = '2026-06-06T13:00:00.000Z'
    expect(feedTsToEpoch(event) > feedTsToEpoch(lastSeen)).toBe(false)
  })

  it('still detects cross-day activity', () => {
    const event = '2026-06-07 09:00:00'
    const lastSeen = '2026-06-06T16:00:00.000Z'
    expect(feedTsToEpoch(event) > feedTsToEpoch(lastSeen)).toBe(true)
  })
})

describe('isUnreadItem', () => {
  const seen = '2026-06-06T13:00:00.000Z'
  const me = 'user-me'

  it('returns false when last-seen is null (first visit shows no dots)', () => {
    expect(isUnreadItem('2026-06-07 09:00:00', 'user-other', null, me)).toBe(false)
  })

  it('marks another user\'s newer item as unread', () => {
    expect(isUnreadItem('2026-06-06 14:00:00', 'user-other', seen, me)).toBe(true)
  })

  it('marks a system item (cron/hearing) as unread', () => {
    expect(isUnreadItem('2026-06-06 14:00:00', 'system', seen, me)).toBe(true)
  })

  it('never marks the current user\'s own action as unread, even if newer', () => {
    expect(isUnreadItem('2026-06-08 09:00:00', me, seen, me)).toBe(false)
  })

  it('returns false for an item older than last-seen', () => {
    expect(isUnreadItem('2026-06-06 12:00:00', 'user-other', seen, me)).toBe(false)
  })

  it('handles a null currentUserId (logged-out edge) without excluding anything', () => {
    expect(isUnreadItem('2026-06-06 14:00:00', 'user-other', seen, null)).toBe(true)
  })
})

describe('relativeTime / absoluteTime mixed-format invariance', () => {
  it('relativeTime gives the same label for space-format and ISO of one instant', () => {
    const space = '2026-06-06 14:00:00'
    const iso = '2026-06-06T14:00:00.000Z'
    expect(relativeTime(space)).toBe(relativeTime(iso))
  })

  it('absoluteTime gives the same rendering for space-format and ISO of one instant', () => {
    const space = '2026-06-06 14:00:00'
    const iso = '2026-06-06T14:00:00.000Z'
    expect(absoluteTime(space)).toBe(absoluteTime(iso))
  })
})
