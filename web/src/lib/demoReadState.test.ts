import { describe, it, expect, vi, afterEach } from 'vitest'
import { readMentionIds, markMentionsRead, isUnreadForDemo } from './demoReadState'

describe('demoReadState', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  const E1 = '2026-08-16T00:00:00.000Z'
  const E2 = '2026-08-16T06:00:00.000Z'

  it('round-trips ids through storage within one epoch', () => {
    markMentionsRead(['a', 'b'], E1)
    markMentionsRead(['b', 'c'], E1)
    expect(readMentionIds(E1)).toEqual(new Set(['a', 'b', 'c']))
  })

  // The reported bug: seeded mention ids are stable across resets, so without
  // epoch scoping a browser that demoed once showed them read forever.
  it('discards read state from an earlier reset epoch', () => {
    markMentionsRead(['a', 'b'], E1)
    expect(readMentionIds(E2)).toEqual(new Set())
  })

  it('does not merge a stale epoch into the new one on write', () => {
    markMentionsRead(['a', 'b'], E1)
    markMentionsRead(['c'], E2)
    expect(readMentionIds(E2)).toEqual(new Set(['c']))
  })

  // Undefined means /config has not answered, or the tenant has never reset.
  // Treating that as a match would let a pre-reset set leak into a new demo.
  it('treats an unknown epoch as no read state, and refuses to write under one', () => {
    markMentionsRead(['a'], E1)
    expect(readMentionIds(undefined)).toEqual(new Set())
    markMentionsRead(['z'], undefined)
    expect(readMentionIds(E1)).toEqual(new Set(['a']))
  })

  it('ignores a malformed or legacy stored value', () => {
    // The pre-epoch format was a bare array; it must not be read as a set.
    localStorage.setItem('floorvote:demo:readMentions', JSON.stringify(['a', 'b']))
    expect(readMentionIds(E1)).toEqual(new Set())
  })

  // test-setup.ts installs a working in-memory localStorage for every suite, so
  // the try/catch in demoReadState.ts — the Safari-private-mode and
  // disabled-storage path its comment justifies — is otherwise never entered.
  // Stub a Storage whose every accessor throws, the way those profiles behave.
  describe('when storage is unavailable', () => {
    function stubThrowingStorage() {
      const throwing = {
        getItem() { throw new DOMException('The operation is insecure.', 'SecurityError') },
        setItem() { throw new DOMException('The operation is insecure.', 'SecurityError') },
        removeItem() { throw new DOMException('The operation is insecure.', 'SecurityError') },
        clear() { throw new DOMException('The operation is insecure.', 'SecurityError') },
        key() { throw new DOMException('The operation is insecure.', 'SecurityError') },
        get length(): number { throw new DOMException('The operation is insecure.', 'SecurityError') },
      }
      vi.stubGlobal('localStorage', throwing)
    }

    it('reads back an empty set rather than throwing', () => {
      stubThrowingStorage()
      expect(readMentionIds('e')).toEqual(new Set())
    })

    it('no-ops on write rather than throwing', () => {
      stubThrowingStorage()
      expect(() => markMentionsRead(['a'], 'e')).not.toThrow()
    })
  })

  // One predicate, imported by both the badge (NotificationsContext) and the
  // panel's rails (NotificationsSlideOver), so the two cannot drift apart.
  describe('isUnreadForDemo', () => {
    it('is unread only when the server says unread and this browser has no local record', () => {
      const read = new Set(['m1'])
      expect(isUnreadForDemo({ id: 'm1', isUnread: true }, read)).toBe(false)
      expect(isUnreadForDemo({ id: 'm2', isUnread: true }, read)).toBe(true)
      // Server-read with no local record: the case where the badge and the panel
      // used to disagree — the badge counted it, every rail rendered it read.
      expect(isUnreadForDemo({ id: 'm3', isUnread: false }, read)).toBe(false)
    })
  })
})
