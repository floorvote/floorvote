import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  justCreatedDraftStorageKey, markJustCreatedDraft, peekJustCreatedDraft,
  clearJustCreatedDraft, takeJustCreatedDraft,
} from './justCreatedDraft'

beforeEach(() => { window.sessionStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); window.sessionStorage.clear() })

describe('just-created-draft marker', () => {
  it('is set for the one draft that was marked', () => {
    markJustCreatedDraft('draft-1')
    expect(peekJustCreatedDraft('draft-1')).toBe(true)
    expect(peekJustCreatedDraft('draft-2')).toBe(false)
  })

  it('is not set for a draft nobody marked', () => {
    expect(peekJustCreatedDraft('draft-1')).toBe(false)
    expect(takeJustCreatedDraft('draft-1')).toBe(false)
  })

  it('peeking leaves the marker in place, so a render can read it any number of times', () => {
    markJustCreatedDraft('draft-1')
    expect(peekJustCreatedDraft('draft-1')).toBe(true)
    expect(peekJustCreatedDraft('draft-1')).toBe(true)
  })

  it('is taken once: true the first time, false after', () => {
    markJustCreatedDraft('draft-1')
    expect(takeJustCreatedDraft('draft-1')).toBe(true)
    expect(takeJustCreatedDraft('draft-1')).toBe(false)
    expect(peekJustCreatedDraft('draft-1')).toBe(false)
  })

  it("taking one draft leaves another draft's marker alone", () => {
    markJustCreatedDraft('draft-1')
    markJustCreatedDraft('draft-2')
    takeJustCreatedDraft('draft-1')
    expect(peekJustCreatedDraft('draft-2')).toBe(true)
  })

  it('clears a marker without reading it', () => {
    markJustCreatedDraft('draft-1')
    clearJustCreatedDraft('draft-1')
    expect(peekJustCreatedDraft('draft-1')).toBe(false)
  })

  it('lives in sessionStorage under one key per draft, not in localStorage', () => {
    markJustCreatedDraft('draft-1')
    expect(window.sessionStorage.getItem(justCreatedDraftStorageKey('draft-1'))).not.toBeNull()
    expect(window.sessionStorage.length).toBe(1)
    expect(window.localStorage.length).toBe(0)
  })

  it('is not set by an unrelated sessionStorage entry', () => {
    window.sessionStorage.setItem('something-else', '1')
    expect(peekJustCreatedDraft('draft-1')).toBe(false)
  })

  describe('when storage is unavailable', () => {
    function breakStorage() {
      const boom = () => { throw new DOMException('blocked', 'SecurityError') }
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom)
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom)
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom)
    }

    it('marking does not throw', () => {
      breakStorage()
      expect(() => markJustCreatedDraft('draft-1')).not.toThrow()
    })

    it('peeking, clearing, and taking do not throw, and report "not just created"', () => {
      breakStorage()
      expect(peekJustCreatedDraft('draft-1')).toBe(false)
      expect(() => clearJustCreatedDraft('draft-1')).not.toThrow()
      expect(takeJustCreatedDraft('draft-1')).toBe(false)
    })

    it('does not throw when the sessionStorage accessor itself throws', () => {
      vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
      expect(() => markJustCreatedDraft('draft-1')).not.toThrow()
      expect(peekJustCreatedDraft('draft-1')).toBe(false)
      expect(takeJustCreatedDraft('draft-1')).toBe(false)
    })
  })
})
