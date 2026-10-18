import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  PANE_COLUMNS, PANE_DEFAULT_WIDTH, PANE_MIN_WIDTH, PANE_KEY_STEP, PANE_WIDTH_STORAGE_KEY,
  paneMaxWidth, clampPaneWidth, visiblePaneColumns, keyboardPaneWidth,
  readStoredPaneWidth, writeStoredPaneWidth, readSidebarWidth, paneGridTemplate,
} from './paneWidth'

afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

describe('pane constants', () => {
  it('starts at today\'s 300px and never goes narrower', () => {
    expect(PANE_DEFAULT_WIDTH).toBe(300)
    expect(PANE_MIN_WIDTH).toBe(300)
    expect(PANE_KEY_STEP).toBe(16)
  })

  it('lists the columns in the order they appear, with their widths', () => {
    expect(PANE_COLUMNS.map(c => [c.key, c.at])).toEqual([
      ['status', 340], ['year', 340], ['lastAction', 480], ['relevance', 570],
    ])
    expect(PANE_COLUMNS.map(c => c.label)).toEqual(['Status', 'Year', 'Last action', 'Relevance'])
  })

  it('leaves priority and position out of the pane', () => {
    expect(PANE_COLUMNS.map(c => c.key)).not.toContain('priority')
    expect(PANE_COLUMNS.map(c => c.key)).not.toContain('position')
  })
})

describe('paneMaxWidth', () => {
  it('leaves the bill page 700px: about 670px at a 1600px window with the default sidebar', () => {
    expect(paneMaxWidth(1600)).toBe(670)
  })
  it('is 510px at the 1440px width where the pane first appears', () => {
    expect(paneMaxWidth(1440)).toBe(510)
  })
  it('gives up room when the sidebar is dragged wider', () => {
    expect(paneMaxWidth(1600, 400)).toBe(500)
  })
  it('never drops below the minimum, however narrow the window', () => {
    expect(paneMaxWidth(1200)).toBe(300)
    expect(paneMaxWidth(0)).toBe(300)
  })
  it('grows with the window', () => {
    expect(paneMaxWidth(2560)).toBe(1630)
  })
})

describe('clampPaneWidth', () => {
  it('keeps a width inside the bounds', () => {
    expect(clampPaneWidth(450, 670)).toBe(450)
  })
  it('raises a width below the minimum', () => {
    expect(clampPaneWidth(120, 670)).toBe(300)
    expect(clampPaneWidth(-5, 670)).toBe(300)
  })
  it('lowers a width above the maximum', () => {
    expect(clampPaneWidth(900, 670)).toBe(670)
  })
  it('allows exactly the bounds', () => {
    expect(clampPaneWidth(300, 670)).toBe(300)
    expect(clampPaneWidth(670, 670)).toBe(670)
  })
  it('rounds to whole pixels', () => {
    expect(clampPaneWidth(450.6, 670)).toBe(451)
  })
  it('falls back to the default for a non-number', () => {
    expect(clampPaneWidth(NaN, 670)).toBe(300)
  })
  it('is the minimum when the maximum is below it', () => {
    expect(clampPaneWidth(500, 200)).toBe(300)
  })
})

describe('visiblePaneColumns', () => {
  const keys = (w: number) => visiblePaneColumns(w).map(c => c.key)
  it('shows none under 340px', () => {
    expect(keys(300)).toEqual([])
    expect(keys(339)).toEqual([])
  })
  it('adds status and year together at 340px, so the first step shows something new', () => {
    expect(keys(340)).toEqual(['status', 'year'])
    expect(keys(479)).toEqual(['status', 'year'])
  })
  it('adds last action at 480px', () => {
    expect(keys(480)).toEqual(['status', 'year', 'lastAction'])
    expect(keys(569)).toEqual(['status', 'year', 'lastAction'])
  })
  it('adds relevance at 570px and keeps all four after', () => {
    expect(keys(570)).toEqual(['status', 'year', 'lastAction', 'relevance'])
    expect(keys(1600)).toEqual(['status', 'year', 'lastAction', 'relevance'])
  })
  it('never repeats a step: each width where the set changes adds columns', () => {
    const sets: string[] = []
    for (let w = 300; w <= 700; w++) {
      const k = keys(w).join(',')
      if (sets[sets.length - 1] !== k) sets.push(k)
    }
    expect(sets).toEqual(['', 'status,year', 'status,year,lastAction', 'status,year,lastAction,relevance'])
  })
  it('puts every breakpoint inside the range a pane can be dragged to at a 1600px window', () => {
    for (const c of PANE_COLUMNS) expect(c.at).toBeLessThanOrEqual(paneMaxWidth(1600))
  })
  it('keeps every breakpoint wide enough for the tracks it shows (multi-state bill track, 8px gaps, 27px padding, 80px for relevance)', () => {
    for (const w of [340, 480, 570]) {
      const tracks = paneGridTemplate(visiblePaneColumns(w), true).split(' ')
      const px = tracks.filter(t => t.endsWith('px')).reduce((n, t) => n + parseInt(t, 10), 0)
      const need = 27 + px + (tracks.length - 1) * 8 + tracks.filter(t => t === 'auto').length * 80
      expect(need).toBeLessThanOrEqual(w)
    }
  })
})

describe('keyboardPaneWidth', () => {
  it('Right widens by 16px and Left narrows by 16px', () => {
    expect(keyboardPaneWidth(400, 'ArrowRight', 670)).toBe(416)
    expect(keyboardPaneWidth(400, 'ArrowLeft', 670)).toBe(384)
  })
  it('stops at the maximum and the minimum', () => {
    expect(keyboardPaneWidth(665, 'ArrowRight', 670)).toBe(670)
    expect(keyboardPaneWidth(670, 'ArrowRight', 670)).toBe(670)
    expect(keyboardPaneWidth(305, 'ArrowLeft', 670)).toBe(300)
    expect(keyboardPaneWidth(300, 'ArrowLeft', 670)).toBe(300)
  })
  it('Home goes to the minimum and End to the maximum', () => {
    expect(keyboardPaneWidth(450, 'Home', 670)).toBe(300)
    expect(keyboardPaneWidth(450, 'End', 670)).toBe(670)
  })
  it('ignores other keys (null, so the caller leaves the event alone)', () => {
    expect(keyboardPaneWidth(450, 'Tab', 670)).toBeNull()
    expect(keyboardPaneWidth(450, 'ArrowUp', 670)).toBeNull()
    expect(keyboardPaneWidth(450, 'Enter', 670)).toBeNull()
  })
})

describe('stored width', () => {
  it('round-trips', () => {
    writeStoredPaneWidth(512)
    expect(readStoredPaneWidth()).toBe(512)
    expect(localStorage.getItem(PANE_WIDTH_STORAGE_KEY)).toBe('512')
  })
  it('is null when nothing is stored', () => {
    expect(readStoredPaneWidth()).toBeNull()
  })
  it('writing null clears it', () => {
    writeStoredPaneWidth(512)
    writeStoredPaneWidth(null)
    expect(readStoredPaneWidth()).toBeNull()
  })
  it.each(['abc', '', '0', '-40', 'NaN', 'Infinity', '1e999'])('ignores the garbage value %j', (raw) => {
    localStorage.setItem(PANE_WIDTH_STORAGE_KEY, raw)
    expect(readStoredPaneWidth()).toBeNull()
  })
  it('reads a stored width larger than any window (the caller clamps it)', () => {
    localStorage.setItem(PANE_WIDTH_STORAGE_KEY, '5000')
    expect(readStoredPaneWidth()).toBe(5000)
  })
  it('is null, not an error, when reading storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(readStoredPaneWidth()).toBeNull()
  })
  it('does not throw when writing storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    expect(() => writeStoredPaneWidth(400)).not.toThrow()
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => writeStoredPaneWidth(null)).not.toThrow()
  })
})

describe('readSidebarWidth', () => {
  it('is the sidebar default of 230px when none is stored', () => {
    expect(readSidebarWidth()).toBe(230)
  })
  it('reads the width the sidebar stored', () => {
    localStorage.setItem('sidebarWidth', '320')
    expect(readSidebarWidth()).toBe(320)
  })
  it('keeps to the sidebar\'s own 230 to 400 range', () => {
    localStorage.setItem('sidebarWidth', '90')
    expect(readSidebarWidth()).toBe(230)
    localStorage.setItem('sidebarWidth', '900')
    expect(readSidebarWidth()).toBe(400)
  })
  it('falls back for garbage and for storage that throws', () => {
    localStorage.setItem('sidebarWidth', 'wide')
    expect(readSidebarWidth()).toBe(230)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(readSidebarWidth()).toBe(230)
  })
})

describe('paneGridTemplate', () => {
  const cols = (n: number) => PANE_COLUMNS.slice(0, n)
  it('is the bill number track alone when no column shows', () => {
    expect(paneGridTemplate([], false)).toBe('70px')
  })
  it('adds a track per column, in order, at the Bills page\'s widths (relevance fits its content)', () => {
    expect(paneGridTemplate(cols(1), false)).toBe('70px 100px')
    expect(paneGridTemplate(cols(2), false)).toBe('70px 100px 90px')
    expect(paneGridTemplate(cols(3), false)).toBe('70px 100px 90px 130px')
    expect(paneGridTemplate(cols(4), false)).toBe('70px 100px 90px 130px auto')
  })
  it('gives a multi-state list the wider bill number track', () => {
    expect(paneGridTemplate(cols(2), true)).toBe('105px 100px 90px')
  })
  it('returns the same columns array for the same width, so memoized rows keep their props', () => {
    expect(visiblePaneColumns(500)).toBe(visiblePaneColumns(520))
    expect(visiblePaneColumns(300)).toBe(visiblePaneColumns(399))
  })
})
