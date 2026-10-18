import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BodyEventsControl } from './BodyEventsControl'
import { ConfigContext, type AppConfig } from '../../context/ConfigContext'
import * as api from '../../lib/api'

// The Calendar page's one gear for committee events (#695): a gear button, one
// popover, and a section per state whose provider publishes its own calendar.
// Saving, revert, and the save queue are #669's and keep their own tests in
// BodyEventsControl.test.tsx. The event-rules API is stubbed.

vi.mock('../../context/DemoContext', () => ({ useDemo: () => ({ demoMode: false, demoLocked: false, settled: true }) }))

const c = (committeeId: string, name: string, state: string) => ({ committeeId, name, chamber: 'C', state })
const HEALTH = c('dc1', 'Committee on Health', 'DC')
const HOUSING = c('dc2', 'Committee on Housing', 'DC')
const COW = c('dc3', 'Committee of the Whole', 'DC')
const FINANCE = c('md1', 'Senate Finance Committee', 'MD')
const APPROPS = c('md2', 'House Appropriations Committee', 'MD')
const ID = (x: { committeeId: string; name: string }) => ({ committeeId: x.committeeId, name: x.name })
const rulesOf = (committees: { committeeId: string; name: string }[], allStates?: string[]) =>
  ({ committees: committees.map(ID), kinds: [], topics: [], trackedBills: false, ...(allStates ? { allStates } : {}) })

const ev = (id: string, state: string, committee: { committeeId: string; name: string } | null, extra: Record<string, unknown> = {}) => ({
  id, date: '2999-01-01', time: null, description: id, url: null,
  facets: { committeeId: committee?.committeeId ?? null, committee: committee?.name ?? null, jointWith: null, state, kind: 'hearing', type: null, title: id, topics: [] },
  trackedOnAgenda: false, prioritizedOnAgenda: false, ...extra,
})

const ONE_STATE = { DC: { bodyEvents: true, deadlines: true, bodyName: 'Council' } }
const TWO_STATES = { ...ONE_STATE, MD: { bodyEvents: true, deadlines: true, bodyName: 'General Assembly' } }
const NO_BODY = { DC: { bodyEvents: false, deadlines: true } }
const MIXED = { ...NO_BODY, MD: { bodyEvents: true, deadlines: true, bodyName: 'General Assembly' } }

let saved: unknown
let loaded: Record<string, unknown>
let putFails: number[] = []
let putCount = 0

function mockApi(rules: unknown, over: Record<string, unknown> = {}) {
  saved = rules
  putFails = []
  putCount = 0
  loaded = {
    hasBodyEvents: true, kinds: [], optionsError: null,
    committees: [HEALTH, HOUSING, COW, FINANCE, APPROPS],
    events: [ev('e1', 'DC', HEALTH), ev('e2', 'DC', HOUSING), ev('e3', 'DC', COW), ev('e4', 'DC', null), ev('e5', 'MD', FINANCE), ev('e6', 'MD', APPROPS)],
    ...over,
  }
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/admin/event-rules' && !init?.method) return { ...loaded, rules: saved } as never
    if (path === '/admin/event-rules' && init?.method === 'PUT') {
      const mine = ++putCount
      if (putFails.includes(mine)) throw new api.ApiError(500, 'Could not save')
      saved = (JSON.parse(String(init.body)) as { rules: unknown }).rules
      return { rules: saved, shown: 1, hidden: 0 } as never
    }
    return {} as never
  })
}
const puts = (spy: ReturnType<typeof mockApi>) =>
  spy.mock.calls.filter(([p, init]) => p === '/admin/event-rules' && init?.method === 'PUT').map(([, init]) => (JSON.parse(String(init!.body)) as { rules: unknown }).rules)

function renderGear(capabilities: AppConfig['capabilities'] = ONE_STATE) {
  return render(
    <ConfigContext value={{ config: { states: Object.keys(capabilities ?? {}), capabilities }, multiState: Object.keys(capabilities ?? {}).length > 1, loading: false }}>
      <BodyEventsControl />
    </ConfigContext>,
  )
}
const gear = () => screen.findByRole('button', { name: 'Committee events settings' })
async function open() {
  const user = userEvent.setup()
  await user.click(await gear())
  return { user, menu: await screen.findByRole('dialog', { name: 'Committee events' }) }
}
const section = (menu: HTMLElement, name: RegExp | string) => within(menu).getByRole('group', { name })

beforeEach(() => { vi.restoreAllMocks() })

describe('the gear (#695)', () => {
  it('is a gear icon button named "Committee events settings", with no label of its own', async () => {
    mockApi(null)
    renderGear()
    const btn = await gear()
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog')
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    expect(btn.textContent).toBe('settings')
    expect(btn.textContent).not.toMatch(/events/i)
    expect(screen.queryByRole('button', { name: /events:/ })).not.toBeInTheDocument()
  })

  it('renders nothing, and asks for nothing, with no covered state that has bodyEvents', async () => {
    const spy = mockApi(null)
    renderGear(NO_BODY)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('button', { name: 'Committee events settings' })).not.toBeInTheDocument()
    expect(spy).not.toHaveBeenCalled()
  })

  it('shows no filtered dot while every state shows every event', async () => {
    mockApi(null)
    renderGear(TWO_STATES)
    await gear()
    expect(screen.queryByTestId('committee-filter-dot')).not.toBeInTheDocument()
  })

  it('shows the filtered dot when any state is filtered, and tells a screen reader', async () => {
    mockApi(rulesOf([HEALTH], ['MD']))
    renderGear(TWO_STATES)
    const btn = await gear()
    await screen.findByTestId('committee-filter-dot')
    expect(btn).toHaveAccessibleDescription(/filtered/i)
  })

  it('shows no dot when the saved rules show every state in full', async () => {
    mockApi(rulesOf([], ['DC', 'MD']))
    renderGear(TWO_STATES)
    await gear()
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('committee-filter-dot')).not.toBeInTheDocument()
  })

  it('gains the dot as soon as a state is filtered, and loses it when all events show again', async () => {
    mockApi(null)
    renderGear()
    const { user, menu } = await open()
    expect(screen.queryByTestId('committee-filter-dot')).not.toBeInTheDocument()
    await user.click(within(menu).getByRole('radio', { name: 'Only these committees' }))
    await screen.findByTestId('committee-filter-dot')
    await user.click(within(menu).getByRole('radio', { name: 'All events' }))
    await waitFor(() => expect(screen.queryByTestId('committee-filter-dot')).not.toBeInTheDocument())
  })

  it('counts only a state that has events to configure: an instance with one capable state among others', async () => {
    mockApi(null)
    renderGear(MIXED)
    const { menu } = await open()
    expect(within(menu).getAllByRole('group', { name: /General Assembly/ })).toHaveLength(1)
    expect(within(menu).queryByRole('group', { name: /^DC/ })).not.toBeInTheDocument()
  })
})

describe('with one configurable state (#695)', () => {
  it('opens a popover with a short intro and that state\'s section already open, headed with its body name', async () => {
    mockApi(null)
    renderGear()
    const { menu } = await open()
    expect(within(menu).getByText('The legislature\'s own calendar, set for each state that publishes one.')).toBeInTheDocument()
    const s = section(menu, /DC Council/)
    expect(within(s).getByRole('radio', { name: 'All events' })).toBeChecked()
    expect(within(s).getByRole('radio', { name: 'Only these committees' })).toBeInTheDocument()
    expect(within(menu).getAllByRole('group', { name: /Council/ })).toHaveLength(1)
  })

  it('has no collapse control: the section is always open', async () => {
    mockApi(null)
    renderGear()
    const { menu } = await open()
    expect(within(section(menu, /DC Council/)).queryByRole('button', { name: /DC Council/ })).not.toBeInTheDocument()
  })

  it('summarizes the state as "All events", or "N of M committees" on the right of its heading', async () => {
    mockApi(rulesOf([HEALTH, HOUSING]))
    renderGear()
    const { menu } = await open()
    expect(within(section(menu, /DC Council/)).getByText('2 of 3 committees')).toBeInTheDocument()
  })

  it('names the state and its body "DC Legislature" when the provider names no body', async () => {
    mockApi(null)
    renderGear({ DC: { bodyEvents: true, deadlines: true } })
    const { menu } = await open()
    expect(section(menu, /DC Legislature/)).toBeInTheDocument()
  })

  it('lists only that state\'s committees, and a "Showing N of M upcoming events" line', async () => {
    mockApi(rulesOf([HEALTH]))
    renderGear()
    const { menu } = await open()
    const s = section(menu, /DC Council/)
    expect(within(s).getAllByRole('checkbox').map(b => (b as HTMLInputElement).labels?.[0]?.textContent)).toEqual(['Committee on Health', 'Committee on Housing', 'Committee of the Whole'])
    expect(within(s).getByText('Showing 1 of 4 upcoming events')).toBeInTheDocument()
  })

  it('shows every event as shown with All events chosen', async () => {
    mockApi(null)
    renderGear()
    const { menu } = await open()
    expect(within(section(menu, /DC Council/)).getByText('Showing 4 of 4 upcoming events')).toBeInTheDocument()
  })

  it('counts an event with a prioritized bill as shown whatever the rules say', async () => {
    mockApi(rulesOf([HEALTH]), { events: [ev('e1', 'DC', HEALTH), ev('e2', 'DC', HOUSING, { prioritizedOnAgenda: true }), ev('e3', 'DC', COW)] })
    renderGear()
    const { menu } = await open()
    expect(within(section(menu, /DC Council/)).getByText('Showing 2 of 3 upcoming events')).toBeInTheDocument()
  })

  it('updates the line as committees are checked', async () => {
    mockApi(rulesOf([HEALTH]))
    renderGear()
    const { user, menu } = await open()
    await user.click(within(menu).getByRole('checkbox', { name: 'Committee on Housing' }))
    await waitFor(() => expect(within(menu).getByText('Showing 2 of 4 upcoming events')).toBeInTheDocument())
  })

  it('keeps the line about prioritized bills at the bottom of the popover', async () => {
    mockApi(null)
    renderGear()
    const { menu } = await open()
    const line = within(menu).getByText('Events with a prioritized bill always show up on the calendar.')
    const s = section(menu, /DC Council/)
    expect(s.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('saves the same rules as before for one state: Only these committees, then a committee', async () => {
    const spy = mockApi(null)
    renderGear()
    const { user, menu } = await open()
    await user.click(within(menu).getByRole('radio', { name: 'Only these committees' }))
    await waitFor(() => expect(puts(spy)).toEqual([rulesOf([])]))
    await user.click(within(menu).getByRole('checkbox', { name: 'Committee on Health' }))
    await waitFor(() => expect(puts(spy)).toHaveLength(2))
    expect(puts(spy)[1]).toEqual(rulesOf([HEALTH]))
  })
})

describe('with two configurable states (#695)', () => {
  it('shows two sections, each headed by its state and body name with its own summary', async () => {
    mockApi(rulesOf([HEALTH, HOUSING], ['MD']))
    renderGear(TWO_STATES)
    const { menu } = await open()
    expect(within(section(menu, /DC Council/)).getByText('2 of 3 committees')).toBeInTheDocument()
    expect(within(section(menu, /MD General Assembly/)).getByText('All events')).toBeInTheDocument()
  })

  it('opens the first section and folds the other, and a heading button opens or closes a section', async () => {
    mockApi(null)
    renderGear(TWO_STATES)
    const { user, menu } = await open()
    const dc = within(menu).getByRole('button', { name: /DC Council/ })
    const md = within(menu).getByRole('button', { name: /MD General Assembly/ })
    expect(dc).toHaveAttribute('aria-expanded', 'true')
    expect(md).toHaveAttribute('aria-expanded', 'false')
    expect(within(menu).getAllByRole('radio', { name: 'All events' })).toHaveLength(1)
    await user.click(md)
    expect(md).toHaveAttribute('aria-expanded', 'true')
    await user.click(dc)
    expect(dc).toHaveAttribute('aria-expanded', 'false')
    expect(within(section(menu, /MD General Assembly/)).getByRole('radio', { name: 'All events' })).toBeInTheDocument()
  })

  it('opens and closes a section from the keyboard', async () => {
    mockApi(null)
    renderGear(TWO_STATES)
    const { user, menu } = await open()
    const md = within(menu).getByRole('button', { name: /MD General Assembly/ })
    md.focus()
    await user.keyboard('{Enter}')
    expect(md).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard(' ')
    expect(md).toHaveAttribute('aria-expanded', 'false')
  })

  it('saves one state and leaves the other as it was', async () => {
    const spy = mockApi(null)
    renderGear(TWO_STATES)
    const { user, menu } = await open()
    await user.click(within(section(menu, /DC Council/)).getByRole('radio', { name: 'Only these committees' }))
    await waitFor(() => expect(puts(spy)).toEqual([rulesOf([], ['MD'])]))
    await user.click(within(menu).getByRole('checkbox', { name: 'Committee on Health' }))
    await waitFor(() => expect(puts(spy)).toHaveLength(2))
    expect(puts(spy)[1]).toEqual(rulesOf([HEALTH], ['MD']))
    // MD still shows every event.
    expect(within(section(menu, /MD General Assembly/)).getByText('All events')).toBeInTheDocument()
  })

  it('filtering the second state keeps the first state\'s committees', async () => {
    const spy = mockApi(rulesOf([HEALTH], ['MD']))
    renderGear(TWO_STATES)
    const { user, menu } = await open()
    await user.click(within(menu).getByRole('button', { name: /MD General Assembly/ }))
    await user.click(within(section(menu, /MD General Assembly/)).getByRole('radio', { name: 'Only these committees' }))
    await waitFor(() => expect(puts(spy)).toHaveLength(1))
    expect(puts(spy)[0]).toEqual(rulesOf([HEALTH]))
    await user.click(within(menu).getByRole('checkbox', { name: 'Senate Finance Committee' }))
    await waitFor(() => expect(puts(spy)).toHaveLength(2))
    expect(puts(spy)[1]).toEqual(rulesOf([HEALTH, FINANCE]))
  })

  it('choosing All events for one state keeps the other state\'s choice', async () => {
    const spy = mockApi(rulesOf([HEALTH, FINANCE]))
    renderGear(TWO_STATES)
    const { user, menu } = await open()
    await user.click(within(section(menu, /DC Council/)).getByRole('radio', { name: 'All events' }))
    await waitFor(() => expect(puts(spy)).toHaveLength(1))
    expect(puts(spy)[0]).toEqual(rulesOf([FINANCE], ['DC']))
  })

  it('clears the rules when both states are set back to All events', async () => {
    const spy = mockApi(rulesOf([FINANCE], ['DC']))
    renderGear(TWO_STATES)
    const { user, menu } = await open()
    await user.click(within(menu).getByRole('button', { name: /MD General Assembly/ }))
    await user.click(within(section(menu, /MD General Assembly/)).getByRole('radio', { name: 'All events' }))
    await waitFor(() => expect(puts(spy)).toEqual([null]))
  })

  it('counts each state\'s events on its own line', async () => {
    mockApi(rulesOf([HEALTH], ['MD']))
    renderGear(TWO_STATES)
    const { user, menu } = await open()
    expect(within(section(menu, /DC Council/)).getByText('Showing 1 of 4 upcoming events')).toBeInTheDocument()
    await user.click(within(menu).getByRole('button', { name: /MD General Assembly/ }))
    expect(within(section(menu, /MD General Assembly/)).getByText('Showing 2 of 2 upcoming events')).toBeInTheDocument()
  })

  it('reverts only the failed save, and says so', async () => {
    const spy = mockApi(rulesOf([HEALTH], ['MD']))
    renderGear(TWO_STATES)
    putFails = [1]
    const { user, menu } = await open()
    await user.click(within(menu).getByRole('checkbox', { name: 'Committee on Housing' }))
    expect(await within(menu).findByRole('alert')).toHaveTextContent(/could not save/i)
    expect(within(menu).getByRole('checkbox', { name: 'Committee on Housing' })).not.toBeChecked()
    expect(within(menu).getByRole('checkbox', { name: 'Committee on Health' })).toBeChecked()
    expect(puts(spy)).toHaveLength(1)
  })
})

describe('the gear with the keyboard and a screen reader (#695)', () => {
  it('opens from the gear with Enter, puts the focus inside the popover, and gives it back on Escape', async () => {
    mockApi(null)
    renderGear(TWO_STATES)
    const user = userEvent.setup()
    const btn = await gear()
    btn.focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('dialog', { name: 'Committee events' })
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    expect(menu.contains(document.activeElement)).toBe(true)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(btn).toHaveFocus()
    expect(btn).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens with Space and closes by pressing the gear again', async () => {
    mockApi(null)
    renderGear()
    const user = userEvent.setup()
    const btn = await gear()
    btn.focus()
    await user.keyboard(' ')
    await screen.findByRole('dialog', { name: 'Committee events' })
    await user.click(btn)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('reaches every radio and checkbox by Tab, without leaving the popover', async () => {
    mockApi(rulesOf([HEALTH]))
    renderGear()
    const { user, menu } = await open()
    const seen = new Set<Element | null>()
    for (let i = 0; i < 12; i++) { seen.add(document.activeElement); await user.tab() }
    expect([...seen].every(el => el && menu.contains(el))).toBe(true)
    for (const name of ['Committee on Health', 'Committee on Housing', 'Committee of the Whole']) {
      expect(seen.has(within(menu).getByRole('checkbox', { name }))).toBe(true)
    }
  })

  it('names each section as a group by its state and body, and its choice as a radio group', async () => {
    mockApi(rulesOf([HEALTH], ['MD']))
    renderGear(TWO_STATES)
    const { menu } = await open()
    expect(within(section(menu, /DC Council/)).getByRole('radiogroup', { name: /which DC Council events show/i })).toBeInTheDocument()
    expect(within(section(menu, /DC Council/)).getByRole('group', { name: 'Committees' })).toBeInTheDocument()
  })

  it('announces a saved choice politely', async () => {
    mockApi(null)
    renderGear()
    const { user, menu } = await open()
    await user.click(within(menu).getByRole('radio', { name: 'Only these committees' }))
    await waitFor(() => expect(within(menu).getByRole('status')).toHaveTextContent(/saved/i))
  })
})
