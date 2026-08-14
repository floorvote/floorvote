import { describe, it, expect, vi, afterEach } from 'vitest'
import { readMentionIds, markMentionsRead, isUnreadForDemo } from './demoReadState'

describe('demoReadState', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('round-trips ids through storage', () => {
    markMentionsRead(['a', 'b'])
    markMentionsRead(['b', 'c'])
    expect(readMentionIds()).toEqual(new Set(['a', 'b', 'c']))
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
      expect(readMentionIds()).toEqual(new Set())
    })

    it('no-ops on write rather than throwing', () => {
      stubThrowingStorage()
      expect(() => markMentionsRead(['a'])).not.toThrow()
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
