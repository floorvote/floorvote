// Property tests for the calendar-date snap. dateFromNow is the one piece of the
// reset whose output is weekday-dependent, and it runs unattended against a live
// public demo on every reset, so its invariants are asserted directly rather than inferred
// from the golden snapshot (which deliberately no longer pins this column).
import { describe, it, expect } from 'vitest'
import { dateFromNow } from '../../src/lib/demoReset'
import { DEMO_SEEDS } from '../../src/lib/demoSeeds'

const DAY = 86400_000
const dayOf = (iso: string) => new Date(iso + 'T00:00:00Z').getUTCDay()
/** 14 consecutive days, so every weekday is a base date at least twice. */
const BASES = Array.from({ length: 14 }, (_, i) => Date.parse('2026-08-03T12:00:00Z') + i * DAY)
const OFFSETS = Array.from({ length: 41 }, (_, i) => i - 10) // -10..+30

describe('dateFromNow', () => {
  it('never returns a Saturday or Sunday, for any base date or offset', () => {
    for (const base of BASES) {
      for (const off of OFFSETS) {
        const d = dateFromNow(off, base)
        expect(dayOf(d), `offset ${off} from ${new Date(base).toISOString().slice(0, 10)} -> ${d}`)
          .not.toBe(0)
        expect(dayOf(d)).not.toBe(6)
      }
    }
  })

  it('keeps a future offset on or after today, and a past offset on or before it', () => {
    for (const base of BASES) {
      const today = new Date(base).toISOString().slice(0, 10)
      for (const off of OFFSETS) {
        const d = dateFromNow(off, base)
        if (off > 0) expect(d >= today, `offset ${off} from ${today} -> ${d} went backwards`).toBe(true)
        if (off < 0) expect(d <= today, `offset ${off} from ${today} -> ${d} went forwards`).toBe(true)
      }
    }
  })

  it('moves a date by at most two days — never further than clearing a weekend', () => {
    for (const base of BASES) {
      for (const off of OFFSETS) {
        const raw = new Date(base + off * DAY).toISOString().slice(0, 10)
        const snapped = dateFromNow(off, base)
        const drift = Math.abs(
          (Date.parse(snapped + 'T00:00:00Z') - Date.parse(raw + 'T00:00:00Z')) / DAY,
        )
        expect(drift, `offset ${off}: ${raw} -> ${snapped}`).toBeLessThanOrEqual(2)
      }
    }
  })

  it('defaults to the real clock when nowMs is omitted', () => {
    expect(dateFromNow(0)).toBe(dateFromNow(0, Date.now()))
  })
})

// The live NJ demo is the reason this matters: its seed has both past and future
// calendar events, and a snap that flipped one across today would reorder the
// calendar on a production site.
describe('every seed survives the snap without a past/future flip', () => {
  for (const slug of Object.keys(DEMO_SEEDS)) {
    it(`${slug}`, () => {
      const seed = DEMO_SEEDS[slug]
      expect(seed.calendarEvents.length).toBeGreaterThan(0)
      for (const base of BASES) {
        const today = new Date(base).toISOString().slice(0, 10)
        for (const e of seed.calendarEvents) {
          const d = dateFromNow(e.offsetDays, base)
          if (e.offsetDays < 0) {
            expect(d < today, `${slug} ${e.id} (offsetDays ${e.offsetDays}) became today-or-later: ${d}`).toBe(true)
          }
          if (e.offsetDays > 2) {
            expect(d > today, `${slug} ${e.id} (offsetDays ${e.offsetDays}) became today-or-earlier: ${d}`).toBe(true)
          }
        }
      }
    })
  }
})

// The golden snapshot used to pin these offsets: calendar_events.date normalized to
// a relative day bucket, so a seed typo showed up as a one-line diff. The weekday
// snap made that bucket run-date-dependent, so the column had to be collapsed —
// and collapsing it lost the pin.
//
// It is NOT enough to recompute the expected date from the seed's own offsetDays:
// that moves with the seed and so cannot detect a change to it. (Verified by
// perturbation — bumping demo-hearing-1 from 2 to 3 left every recomputing
// assertion green.) So the offsets are pinned here as literals, which is what a
// golden value has to be. Changing a seed offset must change this table too.
const EXPECTED_OFFSETS: Record<string, Record<string, number>> = {
  'nj-county-clerks': {
    'demo-hearing-1': 2, 'demo-hearing-2': 6, 'demo-hearing-3': 13,
    'demo-hearing-4': 18, 'demo-hearing-5': 27,
    'demo-event-1': -4, 'demo-event-2': 4, 'demo-event-3': 11,
    'demo-event-4': 20, 'demo-event-5': 25,
  },
  'lake-michigan': {
    'lm-hearing-1': 2, 'lm-hearing-2': 5, 'lm-hearing-3': 9,
    'lm-hearing-4': 13, 'lm-hearing-5': 18, 'lm-hearing-6': 26,
    'lm-event-1': -5, 'lm-event-2': 3, 'lm-event-3': 16, 'lm-event-4': 40,
    // Past entries — the calendar previously held only lm-event-1 behind today.
    'lm-hearing-past-1': -27, 'lm-hearing-past-2': -6,
    'lm-event-past-1': -29, 'lm-event-past-2': -18,
    'lm-event-past-3': -33, 'lm-event-past-4': -47,
  },
}

describe('calendar offsets are pinned', () => {
  for (const slug of Object.keys(DEMO_SEEDS)) {
    it(`${slug} matches the recorded offsets exactly`, () => {
      const actual = Object.fromEntries(
        DEMO_SEEDS[slug].calendarEvents.map(e => [e.id, e.offsetDays]),
      )
      expect(actual).toEqual(EXPECTED_OFFSETS[slug])
    })
  }

  it('covers every registered seed, so a new seed cannot skip the pin', () => {
    expect(Object.keys(EXPECTED_OFFSETS).sort()).toEqual(Object.keys(DEMO_SEEDS).sort())
  })
})
