import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BodyEventsControl } from './BodyEventsControl'
import { ConfigContext, type AppConfig } from '../../context/ConfigContext'
import * as api from '../../lib/api'

const demo = vi.hoisted(() => ({ locked: false }))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: demo.locked, demoLocked: demo.locked, settled: true }),
}))

// The Calendar page's one control for which committee events show (#420): the
// button, its menu of two choices, the committee checklist, and the one line
// for what a rule saved earlier keeps. Everything goes through the existing
// event-rules API, which is stubbed here.

const HOUSING = { committeeId: '3000000001', name: 'Committee on Housing', chamber: 'C', state: 'DC' }
const COW = { committeeId: '3000000002', name: 'Committee of the Whole', chamber: 'C', state: 'DC' }
const YOUTH = { committeeId: '3000000003', name: 'Committee on Youth Affairs', chamber: 'C', state: 'DC' }
const ID = (c: { committeeId: string; name: string }) => ({ committeeId: c.committeeId, name: c.name })
const NO_RULES = { committees: [], kinds: [], topics: [], trackedBills: false }

const LOADED = {
  rules: null as unknown,
  hasBodyEvents: true,
  committees: [COW, HOUSING, YOUTH],
  kinds: [{ kind: 'hearing', types: ['Hearing', 'Roundtable'] }],
  events: [] as unknown[],
  optionsError: null as string | null,
}

const caps = (bodyName?: string): AppConfig['capabilities'] => ({ DC: { bodyEvents: true, deadlines: true, ...(bodyName ? { bodyName } : {}) } })

function renderControl(opts: { capabilities?: AppConfig['capabilities']; demoLocked?: boolean; onChanged?: () => void } = {}) {
  const capabilities = opts.capabilities ?? caps('Council')
  demo.locked = !!opts.demoLocked
  return render(
    <ConfigContext value={{ config: { states: ['DC'], capabilities }, multiState: false, loading: false }}>
      <BodyEventsControl onChanged={opts.onChanged} />
    </ConfigContext>,
  )
}

/** The server's saved rules, so a second GET (a remount) reads what a PUT saved. */
let saved: unknown
let putFails = false
/** Which PUTs fail, by order (1 is the first PUT made), whatever else the stub does. */
let failPuts: number[] = []
let putCount = 0
let putGate: Promise<void> | null = null

function mockApi(rules: unknown = null, extra: Record<string, unknown> = {}) {
  saved = rules
  putFails = false
  failPuts = []
  putCount = 0
  putGate = null
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/admin/event-rules' && !init?.method) return { ...LOADED, ...extra, rules: saved } as never
    if (path === '/admin/event-rules' && init?.method === 'PUT') {
      const mine = ++putCount
      if (putGate) await putGate
      if (putFails || failPuts.includes(mine)) throw new api.ApiError(500, 'Could not save')
      saved = (JSON.parse(String(init.body)) as { rules: unknown }).rules
      return { rules: saved, shown: 1, hidden: 0 } as never
    }
    return {} as never
  })
}

const puts = (spy: ReturnType<typeof mockApi>) =>
  spy.mock.calls.filter(([p, init]) => p === '/admin/event-rules' && init?.method === 'PUT').map(([, init]) => JSON.parse(String(init!.body)) as { rules: unknown })
const getsOf = (spy: ReturnType<typeof mockApi>) =>
  spy.mock.calls.filter(([p, init]) => p === '/admin/event-rules' && !init?.method)

const button = () => screen.findByRole('button', { name: 'Event filters' })
/** The section summary ("All events", "2 of 3 committees"), opening the menu first when it is closed. */
async function summary() {
  if (!screen.queryByRole('dialog')) await userEvent.setup().click(await button())
  return (await screen.findByTestId('state-summary-DC')).textContent
}
async function openMenu() {
  const user = userEvent.setup()
  await user.click(await button())
  return { user, menu: await screen.findByRole('dialog', { name: 'Event filters' }) }
}

beforeEach(() => { vi.restoreAllMocks(); demo.locked = false })

describe('the Calendar page\'s committee events control', () => {
  it('reads "All events" in the section summary by default, with no rules saved', async () => {
    mockApi(null)
    renderControl()
    expect(await button()).toHaveAttribute('aria-haspopup', 'dialog')
    expect(await summary()).toBe('All events')
  })

  it('takes the body\'s name from the provider, and falls back to the legislature\'s when it names none', async () => {
    mockApi(null)
    const { unmount } = renderControl({ capabilities: caps('Assembly') })
    await userEvent.setup().click(await button())
    expect(await screen.findByRole('group', { name: 'DC Assembly' })).toBeInTheDocument()
    unmount()
    renderControl({ capabilities: caps() })
    await userEvent.setup().click(await button())
    expect(await screen.findByRole('group', { name: 'DC Legislature' })).toBeInTheDocument()
  })

  it('offers no control, and asks for nothing, where no covered state publishes its own calendar', async () => {
    const spy = mockApi(null)
    renderControl({ capabilities: { MD: { bodyEvents: false, deadlines: true } } })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('button', { name: 'Event filters' })).not.toBeInTheDocument()
    expect(spy).not.toHaveBeenCalled()
  })

  it('names a committee choice in the section summary', async () => {
    mockApi({ committees: [ID(HOUSING), ID(YOUTH)], kinds: [], topics: [], trackedBills: false })
    renderControl()
    expect(await summary()).toBe('2 of 3 committees')
  })

  it('counts one committee, and none for an empty choice', async () => {
    mockApi({ committees: [ID(HOUSING)], kinds: [], topics: [], trackedBills: false })
    const { unmount } = renderControl()
    expect(await summary()).toBe('1 of 3 committees')
    unmount()
    mockApi(NO_RULES)
    renderControl()
    expect(await summary()).toBe('0 of 3 committees')
  })

  it('opens a menu of two choices and the one note, and shows no committee list while All is chosen', async () => {
    mockApi(null)
    renderControl()
    const { menu } = await openMenu()
    const all = within(menu).getByRole('radio', { name: 'All events' })
    const some = within(menu).getByRole('radio', { name: 'Only these committees' })
    expect(all).toBeChecked()
    expect(some).not.toBeChecked()
    expect(within(menu).getAllByRole('radio')).toHaveLength(2)
    expect(within(menu).getByText('Events with a prioritized bill always show up on the calendar.')).toBeInTheDocument()
    expect(within(menu).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(menu).queryByRole('button', { name: /^Save/ })).not.toBeInTheDocument()
  })

  it('shows no preview of events, kinds, event types, topics, or tracked-bill option, and counts only in the summary and the "Showing" line (#695)', async () => {
    mockApi({ committees: [ID(HOUSING)], kinds: [], topics: [], trackedBills: false }, {
      events: [{ id: 'e1', date: '2026-10-12', time: null, description: 'Housing roundtable', url: null, facets: {}, trackedOnAgenda: false, prioritizedOnAgenda: false }],
    })
    renderControl()
    const { menu } = await openMenu()
    expect(within(menu).queryByText(/Housing roundtable/)).not.toBeInTheDocument()
    expect(within(menu).getAllByText(/\d+ of \d+/)).toHaveLength(2)
    expect(within(menu).queryByText(/Kinds|Event types|Topics|bill we track/i)).not.toBeInTheDocument()
    expect(within(menu).queryByRole('combobox')).not.toBeInTheDocument()
    expect(within(menu).queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('saves "Only these committees" as soon as it is chosen, and then lists the committees', async () => {
    const spy = mockApi(null)
    renderControl()
    const { user, menu } = await openMenu()
    await user.click(within(menu).getByRole('radio', { name: 'Only these committees' }))
    await waitFor(() => expect(puts(spy)).toEqual([{ rules: NO_RULES }]))
    expect(within(menu).getByRole('radio', { name: 'Only these committees' })).toBeChecked()
    for (const c of [COW, HOUSING, YOUTH]) expect(within(menu).getByRole('checkbox', { name: c.name })).not.toBeChecked()
    expect(await summary()).toBe('0 of 3 committees')
  })

  it('saves each committee as it is checked, and drops it as it is unchecked', async () => {
    const spy = mockApi(NO_RULES)
    renderControl()
    const { user, menu } = await openMenu()
    await user.click(within(menu).getByRole('checkbox', { name: 'Committee on Housing' }))
    await waitFor(() => expect(puts(spy)).toHaveLength(1))
    expect(puts(spy)[0]).toEqual({ rules: { committees: [ID(HOUSING)], kinds: [], topics: [], trackedBills: false } })
    await user.click(within(menu).getByRole('checkbox', { name: 'Committee of the Whole' }))
    await waitFor(() => expect(puts(spy)).toHaveLength(2))
    expect(puts(spy)[1]).toEqual({ rules: { committees: [ID(HOUSING), ID(COW)], kinds: [], topics: [], trackedBills: false } })
    await user.click(within(menu).getByRole('checkbox', { name: 'Committee on Housing' }))
    await waitFor(() => expect(puts(spy)).toHaveLength(3))
    expect(puts(spy)[2]).toEqual({ rules: { committees: [ID(COW)], kinds: [], topics: [], trackedBills: false } })
    expect(await summary()).toBe('1 of 3 committees')
  })

  it('clears the rules by choosing "All events", so every event shows again', async () => {
    const spy = mockApi({ committees: [ID(HOUSING)], kinds: [], topics: [], trackedBills: false })
    renderControl()
    const { user, menu } = await openMenu()
    expect(within(menu).getByRole('radio', { name: 'Only these committees' })).toBeChecked()
    expect(within(menu).getByRole('checkbox', { name: 'Committee on Housing' })).toBeChecked()
    await user.click(within(menu).getByRole('radio', { name: 'All events' }))
    await waitFor(() => expect(puts(spy)).toEqual([{ rules: null }]))
    expect(within(menu).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(await summary()).toBe('All events')
  })

  it('tells the calendar after each save, so it shows what the rule now selects', async () => {
    const onChanged = vi.fn()
    mockApi(null)
    renderControl({ onChanged })
    const { user, menu } = await openMenu()
    expect(onChanged).not.toHaveBeenCalled()
    await user.click(within(menu).getByRole('radio', { name: 'Only these committees' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    await user.click(within(menu).getByRole('checkbox', { name: 'Committee on Housing' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2))
  })

  it('saves quick choices in the order they were made', async () => {
    mockApi(NO_RULES)
    let release!: () => void
    renderControl()
    const { user, menu } = await openMenu()
    putGate = new Promise<void>(r => { release = r })
    await user.click(within(menu).getByRole('checkbox', { name: 'Committee on Housing' }))
    await user.click(within(menu).getByRole('checkbox', { name: 'Committee of the Whole' }))
    release()
    await waitFor(() => expect(saved).toEqual({ committees: [ID(HOUSING), ID(COW)], kinds: [], topics: [], trackedBills: false }))
  })

  it('reverts to what is saved, and says so, when a save fails', async () => {
    mockApi({ committees: [ID(HOUSING)], kinds: [], topics: [], trackedBills: false })
    renderControl()
    const { user, menu } = await openMenu()
    putFails = true
    await user.click(within(menu).getByRole('checkbox', { name: 'Committee of the Whole' }))
    expect(await within(menu).findByRole('alert')).toHaveTextContent(/could not save/i)
    expect(within(menu).getByRole('checkbox', { name: 'Committee of the Whole' })).not.toBeChecked()
    expect(within(menu).getByRole('checkbox', { name: 'Committee on Housing' })).toBeChecked()
    expect(await summary()).toBe('1 of 3 committees')
  })

  it('says when the committee list may be incomplete', async () => {
    mockApi(null, { optionsError: 'The lists below may be incomplete: the legislative data service is unavailable right now.' })
    renderControl()
    const { menu } = await openMenu()
    expect(within(menu).getByText(/may be incomplete/)).toBeInTheDocument()
  })

  it('lists a committee a saved rule names though central no longer does', async () => {
    const gone = { committeeId: '3000000099', name: 'Committee on Gone', chamber: null, state: null }
    mockApi({ committees: [ID(gone)], kinds: [], topics: [], trackedBills: false }, { committees: [HOUSING, gone] })
    renderControl()
    const { menu } = await openMenu()
    // The API adds a committee a saved rule names to the list, so the choice never drops silently.
    expect(within(menu).getByRole('checkbox', { name: 'Committee on Gone' })).toBeChecked()
    expect(within(menu).getByRole('checkbox', { name: 'Committee on Housing' })).not.toBeChecked()
  })

  it('says it could not load, instead of a button naming the wrong choice, when the rules do not load', async () => {
    vi.spyOn(api, 'apiFetch').mockRejectedValue(new Error('boom'))
    renderControl()
    expect(await screen.findByRole('button', { name: 'Event filters' })).toBeDisabled()
    expect(screen.queryByTestId('state-summary-DC')).not.toBeInTheDocument()
  })

  it('reads the same rules again on a fresh render: the control keeps nothing of its own', async () => {
    const spy = mockApi(null)
    const first = renderControl()
    const { user, menu } = await openMenu()
    await user.click(within(menu).getByRole('radio', { name: 'Only these committees' }))
    await user.click(within(menu).getByRole('checkbox', { name: 'Committee on Youth Affairs' }))
    await waitFor(() => expect(puts(spy)).toHaveLength(2))
    first.unmount()
    renderControl()
    expect(await summary()).toBe('1 of 3 committees')
    const again = await openMenu()
    expect(within(again.menu).getByRole('checkbox', { name: 'Committee on Youth Affairs' })).toBeChecked()
    expect(getsOf(spy).length).toBeGreaterThanOrEqual(2)
  })

  describe('a rule saved earlier', () => {
    const LEGACY = {
      committees: [{ ...ID(HOUSING), kind: 'Roundtable' }, ID(COW)],
      kinds: ['meeting'],
      topics: [{ name: 'Youth detention', keywords: ['secure detention'] }],
      trackedBills: true,
    }

    it('shows one line, "Kept from an earlier setting: …", with Remove', async () => {
      mockApi(LEGACY)
      renderControl()
      const { menu } = await openMenu()
      const note = within(menu).getByText(/^Kept from an earlier setting:/)
      expect(note).toHaveTextContent('every meeting event')
      expect(note).toHaveTextContent('Youth detention')
      expect(note).toHaveTextContent('a bill we track')
      expect(note).toHaveTextContent('Committee on Housing, Roundtable events only')
      expect(within(menu).getAllByText(/Kept from an earlier setting/)).toHaveLength(1)
      expect(within(menu).getByRole('button', { name: /^Remove/ })).toBeInTheDocument()
      // Still on "Only these committees", with its committees checked.
      expect(within(menu).getByRole('radio', { name: 'Only these committees' })).toBeChecked()
      expect(within(menu).getByRole('checkbox', { name: 'Committee on Housing' })).toBeChecked()
      expect(within(menu).getByRole('checkbox', { name: 'Committee of the Whole' })).toBeChecked()
    })

    it('shows the line for kinds, event types, topics, and tracked bills each on their own', async () => {
      for (const legacy of [{ kinds: ['hearing'] }, { kinds: ['Roundtable'] }, { topics: [{ name: 'T', keywords: ['k'] }] }, { trackedBills: true }]) {
        mockApi({ ...NO_RULES, ...legacy })
        const { unmount } = renderControl()
        const { menu } = await openMenu()
        expect(within(menu).getByText(/^Kept from an earlier setting:/)).toBeInTheDocument()
        unmount()
      }
    })

    it('shows no line for a rule with nothing left over, and none with no rules', async () => {
      mockApi({ committees: [ID(HOUSING)], kinds: [], topics: [], trackedBills: false })
      const { unmount } = renderControl()
      expect((await openMenu()).menu).not.toHaveTextContent(/Kept from an earlier setting/)
      unmount()
      mockApi(null)
      renderControl()
      expect((await openMenu()).menu).not.toHaveTextContent(/Kept from an earlier setting/)
    })

    it('Remove drops what was kept, keeps every committee, and takes the line away', async () => {
      const spy = mockApi(LEGACY)
      const onChanged = vi.fn()
      renderControl({ onChanged })
      const { user, menu } = await openMenu()
      await user.click(within(menu).getByRole('button', { name: /^Remove/ }))
      await waitFor(() => expect(puts(spy)).toHaveLength(1))
      expect(puts(spy)[0]).toEqual({ rules: { committees: [ID(HOUSING), ID(COW)], kinds: [], topics: [], trackedBills: false } })
      await waitFor(() => expect(within(menu).queryByText(/Kept from an earlier setting/)).not.toBeInTheDocument())
      expect(onChanged).toHaveBeenCalled()
      expect(within(menu).getByRole('checkbox', { name: 'Committee on Housing' })).toBeChecked()
    })

    it('Remove puts the focus on something that is still there', async () => {
      mockApi(LEGACY)
      renderControl()
      const { user, menu } = await openMenu()
      await user.click(within(menu).getByRole('button', { name: /^Remove/ }))
      await waitFor(() => expect(within(menu).queryByText(/Kept from an earlier setting/)).not.toBeInTheDocument())
      expect(menu.contains(document.activeElement)).toBe(true)
    })

    it('keeps what was kept while committees are checked and unchecked', async () => {
      const spy = mockApi(LEGACY)
      renderControl()
      const { user, menu } = await openMenu()
      await user.click(within(menu).getByRole('checkbox', { name: 'Committee on Youth Affairs' }))
      await waitFor(() => expect(puts(spy)).toHaveLength(1))
      expect(puts(spy)[0]).toEqual({ rules: { ...LEGACY, committees: [...LEGACY.committees, ID(YOUTH)] } })
      expect(within(menu).getByText(/^Kept from an earlier setting:/)).toBeInTheDocument()
      await user.click(within(menu).getByRole('checkbox', { name: 'Committee of the Whole' }))
      await waitFor(() => expect(puts(spy)).toHaveLength(2))
      expect(puts(spy)[1]).toEqual({ rules: { ...LEGACY, committees: [LEGACY.committees[0], ID(YOUTH)] } })
    })

    it('a rule of only kinds, with no committees, still reads as a choice and can be removed', async () => {
      const spy = mockApi({ ...NO_RULES, kinds: ['Roundtable'] })
      renderControl()
      const { user, menu } = await openMenu()
      expect(within(menu).getByRole('radio', { name: 'Only these committees' })).toBeChecked()
      await user.click(within(menu).getByRole('button', { name: /^Remove/ }))
      await waitFor(() => expect(puts(spy)).toEqual([{ rules: NO_RULES }]))
    })

    it('choosing "All events" clears a rule saved earlier too', async () => {
      const spy = mockApi(LEGACY)
      renderControl()
      const { user, menu } = await openMenu()
      await user.click(within(menu).getByRole('radio', { name: 'All events' }))
      await waitFor(() => expect(puts(spy)).toEqual([{ rules: null }]))
      expect(within(menu).queryByText(/Kept from an earlier setting/)).not.toBeInTheDocument()
    })
  })


  describe('when a save fails with others queued behind it', () => {
    it('skips the saves queued behind it, so the server and the screen agree, and shows the alert', async () => {
      mockApi(NO_RULES)
      let release!: () => void
      renderControl()
      const { user, menu } = await openMenu()
      putGate = new Promise<void>(r => { release = r })
      failPuts = [1]
      await user.click(within(menu).getByRole('checkbox', { name: 'Committee on Housing' }))
      await user.click(within(menu).getByRole('checkbox', { name: 'Committee of the Whole' }))
      release()
      expect(await within(menu).findByRole('alert')).toHaveTextContent(/could not save/i)
      // The second save was built on a state the server never took, so it is never sent.
      expect(saved).toEqual(NO_RULES)
      expect(putCount).toBe(1)
      expect(within(menu).getByRole('checkbox', { name: 'Committee on Housing' })).not.toBeChecked()
      expect(within(menu).getByRole('checkbox', { name: 'Committee of the Whole' })).not.toBeChecked()
      expect(await summary()).toBe('0 of 3 committees')
      expect(within(menu).getByRole('status')).not.toHaveTextContent(/saved/i)
    })

    it('does the same when "All events" is picked behind a failing save: the rules are not cleared on the server', async () => {
      mockApi(NO_RULES)
      let release!: () => void
      renderControl()
      const { user, menu } = await openMenu()
      putGate = new Promise<void>(r => { release = r })
      failPuts = [1]
      await user.click(within(menu).getByRole('checkbox', { name: 'Committee on Housing' }))
      await user.click(within(menu).getByRole('radio', { name: 'All events' }))
      release()
      expect(await within(menu).findByRole('alert')).toHaveTextContent(/could not save/i)
      expect(saved).toEqual(NO_RULES)
      expect(putCount).toBe(1)
      expect(within(menu).getByRole('radio', { name: 'Only these committees' })).toBeChecked()
      expect(await summary()).toBe('0 of 3 committees')
    })

    it('saves a choice made after the failure, on what the server holds', async () => {
      mockApi({ committees: [ID(YOUTH)], kinds: [], topics: [], trackedBills: false })
      renderControl()
      const { user, menu } = await openMenu()
      failPuts = [1]
      await user.click(within(menu).getByRole('checkbox', { name: 'Committee on Housing' }))
      expect(await within(menu).findByRole('alert')).toBeInTheDocument()
      await user.click(within(menu).getByRole('checkbox', { name: 'Committee of the Whole' }))
      await waitFor(() => expect(saved).toEqual({ committees: [ID(YOUTH), ID(COW)], kinds: [], topics: [], trackedBills: false }))
      await waitFor(() => expect(within(menu).queryByRole('alert')).not.toBeInTheDocument())
      expect(within(menu).getByRole('checkbox', { name: 'Committee on Housing' })).not.toBeChecked()
      expect(await summary()).toBe('2 of 3 committees')
    })
  })

  describe('"All events" in the same session', () => {
    const LEGACY = {
      committees: [{ ...ID(HOUSING), kind: 'Roundtable' }, ID(COW)],
      kinds: ['meeting'],
      topics: [{ name: 'Youth detention', keywords: ['secure detention'] }],
      trackedBills: true,
    }

    it('is undone by arrowing back to "Only these committees": the rules come back whole', async () => {
      const spy = mockApi(LEGACY)
      renderControl()
      const { user, menu } = await openMenu()
      const only = within(menu).getByRole('radio', { name: 'Only these committees' })
      only.focus()
      await user.keyboard('{ArrowUp}')
      await waitFor(() => expect(puts(spy)).toEqual([{ rules: null }]))
      expect(within(menu).queryByRole('checkbox')).not.toBeInTheDocument()
      await user.keyboard('{ArrowDown}')
      await waitFor(() => expect(puts(spy)).toHaveLength(2))
      expect(puts(spy)[1]).toEqual({ rules: LEGACY })
      expect(saved).toEqual(LEGACY)
      expect(within(menu).getByRole('checkbox', { name: 'Committee on Housing' })).toBeChecked()
      expect(within(menu).getByRole('checkbox', { name: 'Committee of the Whole' })).toBeChecked()
      expect(within(menu).getByText(/^Kept from an earlier setting:/)).toBeInTheDocument()
    })

    it('restores the choices as they stood, after changes made this session', async () => {
      const spy = mockApi({ committees: [ID(HOUSING)], kinds: [], topics: [], trackedBills: false })
      renderControl()
      const { user, menu } = await openMenu()
      await user.click(within(menu).getByRole('checkbox', { name: 'Committee on Youth Affairs' }))
      await user.click(within(menu).getByRole('radio', { name: 'All events' }))
      await user.click(within(menu).getByRole('radio', { name: 'Only these committees' }))
      await waitFor(() => expect(puts(spy)).toHaveLength(3))
      expect(puts(spy)[2]).toEqual({ rules: { committees: [ID(HOUSING), ID(YOUTH)], kinds: [], topics: [], trackedBills: false } })
    })

    it('starts from no committees when there was nothing to restore', async () => {
      const spy = mockApi(null)
      renderControl()
      const { user, menu } = await openMenu()
      await user.click(within(menu).getByRole('radio', { name: 'Only these committees' }))
      await waitFor(() => expect(puts(spy)).toEqual([{ rules: NO_RULES }]))
    })

    it('forgets nothing it was not asked to: Remove before All leaves the removed parts gone on the way back', async () => {
      const spy = mockApi(LEGACY)
      renderControl()
      const { user, menu } = await openMenu()
      await user.click(within(menu).getByRole('button', { name: /^Remove/ }))
      await user.click(within(menu).getByRole('radio', { name: 'All events' }))
      await user.click(within(menu).getByRole('radio', { name: 'Only these committees' }))
      await waitFor(() => expect(puts(spy)).toHaveLength(3))
      expect(puts(spy)[2]).toEqual({ rules: { committees: [ID(HOUSING), ID(COW)], kinds: [], topics: [], trackedBills: false } })
    })
  })

  describe('with the keyboard and a screen reader', () => {
    it('opens from the button with Enter or Space, and names its state', async () => {
      mockApi(null)
      renderControl()
      const user = userEvent.setup()
      const btn = await button()
      expect(btn).toHaveAttribute('aria-expanded', 'false')
      btn.focus()
      await user.keyboard('{Enter}')
      expect(await screen.findByRole('dialog', { name: 'Event filters' })).toBeInTheDocument()
      expect(btn).toHaveAttribute('aria-expanded', 'true')
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(btn).toHaveAttribute('aria-expanded', 'false')
      await user.keyboard(' ')
      expect(await screen.findByRole('dialog', { name: 'Event filters' })).toBeInTheDocument()
    })

    it('puts the focus in the menu, and gives it back to the button on Escape', async () => {
      mockApi(null)
      renderControl()
      const btn = await button()
      const { user, menu } = await openMenu()
      expect(menu.contains(document.activeElement)).toBe(true)
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(btn).toHaveFocus()
    })

    it('chooses with the arrow keys and Space, and checks committees with Space', async () => {
      const spy = mockApi(null)
      renderControl()
      const { user, menu } = await openMenu()
      expect(within(menu).getByRole('radio', { name: 'All events' })).toHaveFocus()
      await user.keyboard('{ArrowDown}')
      expect(within(menu).getByRole('radio', { name: 'Only these committees' })).toBeChecked()
      await waitFor(() => expect(puts(spy)).toEqual([{ rules: NO_RULES }]))
      await user.tab()
      expect(within(menu).getByRole('checkbox', { name: 'Committee of the Whole' })).toHaveFocus()
      await user.keyboard(' ')
      await waitFor(() => expect(puts(spy)).toHaveLength(2))
      expect(puts(spy)[1]).toEqual({ rules: { committees: [ID(COW)], kinds: [], topics: [], trackedBills: false } })
    })

    it('groups the two choices and the committees, each with a name', async () => {
      mockApi(NO_RULES)
      renderControl()
      const { menu } = await openMenu()
      expect(within(menu).getByRole('radiogroup', { name: /which DC Council events/i })).toBeInTheDocument()
      expect(within(menu).getByRole('group', { name: 'Committees' })).toBeInTheDocument()
    })

    it('announces a saved choice politely, apart from the error alert', async () => {
      mockApi(null)
      renderControl()
      const { user, menu } = await openMenu()
      await user.click(within(menu).getByRole('radio', { name: 'Only these committees' }))
      await waitFor(() => expect(within(menu).getByRole('status')).toHaveTextContent(/saved/i))
      expect(within(menu).queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  it('is disabled, and saves nothing, on a locked demo', async () => {
    const spy = mockApi({ committees: [ID(HOUSING)], kinds: [], topics: [], trackedBills: false })
    renderControl({ demoLocked: true })
    const { user, menu } = await openMenu()
    expect(within(menu).getByRole('radio', { name: 'All events' })).toBeDisabled()
    expect(within(menu).getByRole('radio', { name: 'Only these committees' })).toBeDisabled()
    expect(within(menu).getByRole('checkbox', { name: 'Committee on Housing' })).toBeDisabled()
    await user.click(within(menu).getByRole('checkbox', { name: 'Committee on Housing' }))
    expect(puts(spy)).toEqual([])
  })
})
