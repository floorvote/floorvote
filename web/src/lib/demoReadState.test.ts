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

  // Undefined means /config has not answered, or the tenant has not been reset
  // since demo_reset_at shipped. A real epoch's state must not be visible under
  // it — that would be the leak the scoping exists to prevent.
  it('does not see a real epoch’s read state under an unknown epoch', () => {
    markMentionsRead(['a'], E1)
    expect(readMentionIds(undefined)).toEqual(new Set())
  })

  // The regression this guards: refusing to WRITE without an epoch left the
  // badge permanently lit on every demo tenant between deploy and its next
  // reset — opening the panel could never clear it.
  it('still records read state when the epoch is unknown', () => {
    markMentionsRead(['a', 'b'], undefined)
    expect(readMentionIds(undefined)).toEqual(new Set(['a', 'b']))
  })

  // And the first real reset must still re-light them, which is the point of
  // the whole mechanism.
  it('discards unknown-epoch state once a real epoch arrives', () => {
    markMentionsRead(['a', 'b'], undefined)
    expect(readMentionIds(E1)).toEqual(new Set())
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
