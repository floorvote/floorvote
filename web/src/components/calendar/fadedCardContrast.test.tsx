import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { EventItem } from './EventItem'
import { MonthGrid } from './MonthGrid'
import type { CalendarEvent } from '../../lib/calendarGrid'
import { contrast, resolveColor, type Mode } from '../../test/colorTokens'

// Pin "today" so 2026-06-10 is past and 2026-06-20 is upcoming in the month view.
vi.mock('../../lib/calendarGrid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/calendarGrid')>()
  return { ...actual, todayIso: () => '2026-06-15' }
})

const MODES: Mode[] = ['light', 'dark']

function richEvent(over: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'e1', uid: 'u1', source: 'hearing', billId: 'b1',
    bills: [{ id: 'b1', billNumber: 'H 100', billTitle: 'Elections', state: 'RI', priority: 'high', isDraft: false }],
    date: '2999-01-01', time: '09:00', location: 'Room 1', description: 'Elections Cmte',
    details: 'Short agenda details', url: 'https://example.com/agenda', status: 'confirmed', ...over,
  }
}

function renderCard(event: CalendarEvent, isPast: boolean) {
  const { container } = render(
    <MemoryRouter>
      <EventItem event={event} isPast={isPast} isAdmin={false} editing={false} billOptions={[]}
        onEdit={vi.fn()} onEditSave={vi.fn()} onEditCancel={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />
    </MemoryRouter>,
  )
  return container.firstElementChild as HTMLElement
}

function ownBackground(el: HTMLElement): string {
  return el.style.background || el.style.backgroundColor
}

/** The var() fill behind `el`: its own, else the nearest ancestor's inline one. */
function fillBehind(el: HTMLElement): string {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const bg = ownBackground(n)
    if (bg.startsWith('var(')) return bg
  }
  throw new Error('no token fill behind element')
}

/** Every element with an inline text color token, with the contrast against its fill. */
function textContrasts(card: HTMLElement, mode: Mode) {
  const els = [card, ...card.querySelectorAll<HTMLElement>('*')].filter(e => e.style.color.startsWith('var('))
  return els.map(e => ({
    el: e,
    label: `${e.tagName.toLowerCase()} "${(e.textContent ?? '').trim().slice(0, 20)}" ${e.style.color}`,
    ratio: contrast(resolveColor(e.style.color, mode), resolveColor(fillBehind(e), mode)),
  }))
}

const cases: Array<[string, CalendarEvent, boolean]> = [
  ['past', richEvent({ date: '2000-01-01' }), true],
  ['cancelled', richEvent({ status: 'cancelled' }), false],
  ['past and cancelled', richEvent({ date: '2000-01-01', status: 'cancelled' }), true],
]

describe('faded agenda cards keep readable text', () => {
  for (const [name, ev, isPast] of cases) {
    for (const mode of MODES) {
      it(`${name} card: every text and link color meets 4.5:1 in ${mode} mode`, () => {
        const rows = textContrasts(renderCard(ev, isPast), mode)
        expect(rows.length).toBeGreaterThan(4)
        // The link and "Show more" colors must be among those measured.
        expect(rows.some(r => r.el.tagName === 'A' && r.el.getAttribute('href') === 'https://example.com/agenda')).toBe(true)
        for (const r of rows) expect(r.ratio, r.label).toBeGreaterThanOrEqual(4.5)
      })
    }
    it(`${name} card is not faded with opacity`, () => {
      expect(renderCard(ev, isPast).style.opacity).toBe('')
    })
  }

  it('long details show the "Show more" control at 4.5:1 on a past card', () => {
    const ev = richEvent({ date: '2000-01-01', details: 'x'.repeat(200) })
    for (const mode of MODES) {
      const rows = textContrasts(renderCard(ev, true), mode)
      const more = rows.find(r => r.el.textContent === 'Show more')
      expect(more).toBeDefined()
      expect(more!.ratio).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('a faded card is still visibly distinct from an upcoming one', () => {
    const upcoming = renderCard(richEvent({}), false)
    for (const [, ev, isPast] of cases) {
      const faded = renderCard(ev, isPast)
      expect(faded.style.background).not.toBe(upcoming.style.background)
      expect(faded.style.boxShadow).not.toBe(upcoming.style.boxShadow)
    }
  })

  it('an upcoming confirmed card is unchanged (surface fill, no fade)', () => {
    const upcoming = renderCard(richEvent({}), false)
    expect(upcoming.style.opacity).toBe('')
    expect(upcoming.style.background).toBe('var(--fv-white)')
  })

  it('a card being edited keeps the plain surface even when past', () => {
    const { container } = render(
      <MemoryRouter>
        <EventItem event={richEvent({ date: '2000-01-01' })} isPast isAdmin editing billOptions={[]}
          onEdit={vi.fn()} onEditSave={vi.fn()} onEditCancel={vi.fn()} onDelete={vi.fn()} onRestore={vi.fn()} />
      </MemoryRouter>,
    )
    const card = container.firstElementChild as HTMLElement
    expect(card.style.opacity).toBe('')
    expect(card.style.background).toBe('var(--fv-white)')
  })
})

describe('faded month-view events', () => {
  function monthCard(date: string, status: CalendarEvent['status'] = 'confirmed') {
    const ev = richEvent({ date, status, id: `m-${date}`, description: `Event ${date}`, details: null, url: null })
    render(
      <MemoryRouter>
        <MonthGrid events={[ev]} initialYear={2026} initialMonth={5} onSelect={vi.fn()} />
      </MemoryRouter>,
    )
    return [...document.querySelectorAll('button')].find(b => b.textContent?.includes(`Event ${date}`)) as HTMLElement
  }

  for (const mode of MODES) {
    it(`past month card: text meets 4.5:1 in ${mode} mode and no opacity`, () => {
      const card = monthCard('2026-06-10')
      expect(card.style.opacity).toBe('')
      const rows = textContrasts(card, mode)
      expect(rows.length).toBeGreaterThan(1)
      for (const r of rows) expect(r.ratio, r.label).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('past month card is distinct from an upcoming one', () => {
    const past = monthCard('2026-06-10')
    document.body.innerHTML = ''
    const upcoming = monthCard('2026-06-20')
    expect(past.style.background).not.toBe(upcoming.style.background)
    expect(upcoming.style.opacity).toBe('')
  })
})

describe('past card titles', () => {
  const titleOf = (card: HTMLElement) =>
    [...card.querySelectorAll<HTMLElement>('div')].find(d => d.textContent === 'Elections Cmte') as HTMLElement

  it('a past title uses textSecondary, unlike an upcoming one', () => {
    const past = titleOf(renderCard(richEvent({ date: '2000-01-01' }), true))
    document.body.innerHTML = ''
    const upcoming = titleOf(renderCard(richEvent({}), false))
    expect(past.style.color).toBe('var(--fv-text-secondary)')
    expect(past.style.color).not.toBe(upcoming.style.color)
  })

  it('a cancelled title keeps textMuted with line-through, even when past', () => {
    const t = titleOf(renderCard(richEvent({ date: '2000-01-01', status: 'cancelled' }), true))
    expect(t.style.color).toBe('var(--fv-text-muted)')
    expect(t.style.textDecoration).toBe('line-through')
  })

  for (const mode of MODES) {
    it(`a past title meets 4.5:1 on the muted fill in ${mode} mode`, () => {
      const t = titleOf(renderCard(richEvent({ date: '2000-01-01' }), true))
      expect(contrast(resolveColor(t.style.color, mode), resolveColor(fillBehind(t), mode))).toBeGreaterThanOrEqual(4.5)
    })
  }
})
