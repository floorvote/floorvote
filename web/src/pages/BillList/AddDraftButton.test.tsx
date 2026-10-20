import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { AddDraftButton } from './AddDraftButton'
import { peekJustCreatedDraft } from '../../lib/justCreatedDraft'
import * as api from '../../lib/api'
import { color, fontSize, fontWeight } from '../../styles/tokens'
import { contrast, resolveColor } from '../../test/colorTokens'

// Mutable flag so a test can opt into a locked demo without a module-level
// mock rewrite.
const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked, settled: true }),
}))

// Where the click landed, and with what router state. The just-created marker
// is not router state: a loader redirect replaces it and a reload keeps it, so it
// lives in sessionStorage (lib/justCreatedDraft.ts), and the page carries none.
function Landing() {
  const loc = useLocation()
  return (
    <div>
      <div data-testid="path">{loc.pathname}</div>
      <div data-testid="raw-state">{JSON.stringify(loc.state)}</div>
    </div>
  )
}

function renderButton() {
  return render(
    <MemoryRouter initialEntries={['/bills']}>
      <Routes>
        <Route path="/bills" element={<><AddDraftButton /><Landing /></>} />
        <Route path="/bills/:id" element={<Landing />} />
      </Routes>
    </MemoryRouter>,
  )
}

type Defaults = { tenantState: string | null }
interface Server {
  defaults?: Defaults | Error | (() => Defaults | Promise<Defaults>)
  states?: string[] | Error
  create?: (init: RequestInit) => unknown | Promise<unknown>
}

// Routes apiFetch by path, as the page tests do, and records every call.
function mockApi(server: Server = {}) {
  const calls: { path: string; init?: RequestInit }[] = []
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    calls.push({ path, init })
    if (path === '/bills/draft-defaults') {
      const d = server.defaults ?? { tenantState: 'UT' }
      if (d instanceof Error) throw d
      return (typeof d === 'function' ? await d() : d) as never
    }
    if (path === '/bills/draft-states') {
      const st = server.states ?? []
      if (st instanceof Error) throw st
      return { states: st } as never
    }
    if (path === '/bills/draft' && init?.method === 'POST') {
      return (await (server.create ? server.create(init) : { id: 'new-draft-1' })) as never
    }
    return {} as never
  })
  const posts = () => calls.filter(c => c.path === '/bills/draft' && c.init?.method === 'POST')
  const postBodies = () => posts().map(c => (c.init?.body ? JSON.parse(c.init.body as string) : null))
  return { calls, posts, postBodies }
}

describe('AddDraftButton', () => {
  beforeEach(() => { vi.restoreAllMocks(); demoState.demoLocked = false; window.sessionStorage.clear() })
  afterEach(() => { demoState.demoLocked = false; window.sessionStorage.clear() })

  describe('single-state tenant', () => {
    it('creates a blank draft with no state and opens its page marked as just created', async () => {
      const server = mockApi({ defaults: { tenantState: 'UT' } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))

      await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/bills/new-draft-1'))
      expect(server.posts()).toHaveLength(1)
      // An empty body: the server fills in the number, the year, and the state.
      expect(server.postBodies()[0]).toBeNull()
      expect(peekJustCreatedDraft('new-draft-1')).toBe(true)
      // The marker is in sessionStorage, not in the navigation: no router state rides along.
      expect(screen.getByTestId('raw-state')).toHaveTextContent('null')
    })

    it('opens no menu and no text field', async () => {
      mockApi({ defaults: { tenantState: 'UT' }, states: ['UT', 'CO'] })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/bills/new-draft-1'))
      expect(screen.queryByRole('menu')).toBeNull()
      expect(screen.queryByLabelText(/state/i)).toBeNull()
    })

    it('decides single-state from draft-defaults, not from how many states have bills', async () => {
      // Two states have bills, but the tenant is configured for one: still one click.
      const server = mockApi({ defaults: { tenantState: 'UT' }, states: ['UT', 'CO'] })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await waitFor(() => expect(server.posts()).toHaveLength(1))
      expect(server.postBodies()[0]).toBeNull()
    })

    it('creates only once when clicked twice while the request is in flight', async () => {
      let release: (v: unknown) => void = () => {}
      const server = mockApi({ create: () => new Promise(res => { release = res }) })
      renderButton()
      const button = screen.getByRole('button', { name: 'Add draft bill' })
      fireEvent.click(button)
      await waitFor(() => expect(server.posts()).toHaveLength(1))
      fireEvent.click(button)
      fireEvent.click(button)
      expect(server.posts()).toHaveLength(1)
      release({ id: 'new-draft-1' })
      await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/bills/new-draft-1'))
      expect(server.posts()).toHaveLength(1)
    })
  })

  describe('multi-state tenant with states that have bills', () => {
    it('opens a menu of the facet states instead of creating', async () => {
      const server = mockApi({ defaults: { tenantState: null }, states: ['UT', 'CO'] })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))

      expect(await screen.findByRole('menuitem', { name: 'CO' })).toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: 'UT' })).toBeInTheDocument()
      expect(server.posts()).toHaveLength(0)
      expect(screen.getByTestId('path')).toHaveTextContent('/bills')
    })

    it('lists the states in alphabetical order', async () => {
      mockApi({ defaults: { tenantState: null }, states: ['UT', 'CO', 'AZ'] })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await screen.findByRole('menuitem', { name: 'AZ' })
      expect(screen.getAllByRole('menuitem').map(el => el.textContent)).toEqual(['AZ', 'CO', 'UT'])
    })

    it('creates the draft in the picked state and opens its page marked as just created', async () => {
      const server = mockApi({ defaults: { tenantState: null }, states: ['UT', 'CO'] })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'CO' }))

      await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/bills/new-draft-1'))
      expect(server.postBodies()).toEqual([{ state: 'CO' }])
      expect(peekJustCreatedDraft('new-draft-1')).toBe(true)
    })

    it('still offers the menu when only one state has bills', async () => {
      // One state with bills does not make the tenant single-state: draft-defaults says null.
      const server = mockApi({ defaults: { tenantState: null }, states: ['UT'] })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      expect(await screen.findByRole('menuitem', { name: 'UT' })).toBeInTheDocument()
      expect(server.posts()).toHaveLength(0)
    })

    it('closes the menu on Escape without creating anything', async () => {
      const server = mockApi({ defaults: { tenantState: null }, states: ['UT', 'CO'] })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await screen.findByRole('menuitem', { name: 'CO' })
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
      expect(server.posts()).toHaveLength(0)
    })

    it('closes the menu on a click outside it without creating anything', async () => {
      const server = mockApi({ defaults: { tenantState: null }, states: ['UT', 'CO'] })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await screen.findByRole('menuitem', { name: 'CO' })
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('menu')).toBeNull()
      expect(server.posts()).toHaveLength(0)
    })

    it('closes the menu when the button is clicked again', async () => {
      mockApi({ defaults: { tenantState: null }, states: ['UT', 'CO'] })
      renderButton()
      const button = screen.getByRole('button', { name: 'Add draft bill' })
      fireEvent.click(button)
      await screen.findByRole('menuitem', { name: 'CO' })
      fireEvent.click(button)
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })

  describe('multi-state tenant with no bills yet', () => {
    it('offers a two-letter text field instead of a menu', async () => {
      mockApi({ defaults: { tenantState: null }, states: [] })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      const field = await screen.findByRole('textbox', { name: 'State' })
      expect(field).toHaveAttribute('maxlength', '2')
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('creates the draft with the typed state, uppercased', async () => {
      const server = mockApi({ defaults: { tenantState: null }, states: [] })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      const user = userEvent.setup()
      await user.type(await screen.findByRole('textbox', { name: 'State' }), 'ut')
      await user.click(screen.getByRole('button', { name: 'Create draft' }))

      await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/bills/new-draft-1'))
      expect(server.postBodies()).toEqual([{ state: 'UT' }])
      expect(peekJustCreatedDraft('new-draft-1')).toBe(true)
    })

    it('submits the typed state on Enter', async () => {
      const server = mockApi({ defaults: { tenantState: null }, states: [] })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      const user = userEvent.setup()
      await user.type(await screen.findByRole('textbox', { name: 'State' }), 'co{Enter}')
      await waitFor(() => expect(server.postBodies()).toEqual([{ state: 'CO' }]))
    })

    it('does not create with a blank state', async () => {
      const server = mockApi({ defaults: { tenantState: null }, states: [] })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await screen.findByRole('textbox', { name: 'State' })
      fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
      expect(server.posts()).toHaveLength(0)
      expect(screen.getByTestId('path')).toHaveTextContent('/bills')
    })

    it('does not create with a one-letter state', async () => {
      const server = mockApi({ defaults: { tenantState: null }, states: [] })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      const user = userEvent.setup()
      await user.type(await screen.findByRole('textbox', { name: 'State' }), 'u{Enter}')
      fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
      expect(server.posts()).toHaveLength(0)
    })

    it('does not accept more than two letters or non-letters', async () => {
      const server = mockApi({ defaults: { tenantState: null }, states: [] })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      const user = userEvent.setup()
      const field = await screen.findByRole('textbox', { name: 'State' })
      await user.type(field, '1u2tx{Enter}')
      expect(field).toHaveValue('UT')
      await waitFor(() => expect(server.postBodies()).toEqual([{ state: 'UT' }]))
    })

    it('falls back to the text field when the states call fails', async () => {
      mockApi({ defaults: { tenantState: null }, states: new api.ApiError(500, 'boom') })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      expect(await screen.findByRole('textbox', { name: 'State' })).toBeInTheDocument()
    })
  })

  describe('prefetch: the click answers from what the page already fetched', () => {
    // Lets every request started by the mount settle.
    const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    it('asks draft-defaults and the state list once each when the page mounts, before any click', async () => {
      const server = mockApi({ defaults: { tenantState: null }, states: ['UT', 'CO'] })
      renderButton()
      await settle()
      expect(server.calls.map(c => c.path).sort()).toEqual(['/bills/draft-defaults', '/bills/draft-states'])
    })

    it('never asks for the full facets, which compute every facet to read a few state names', async () => {
      const server = mockApi({ defaults: { tenantState: null }, states: ['UT', 'CO'] })
      renderButton()
      await settle()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await screen.findByRole('menuitem', { name: 'CO' })
      await settle()
      expect(server.calls.some(c => c.path.startsWith('/bills/facets'))).toBe(false)
    })

    it('opens the state menu on the click itself, with no request left to wait for', async () => {
      const server = mockApi({ defaults: { tenantState: null }, states: ['UT', 'CO'] })
      renderButton()
      await settle()
      const before = server.calls.length
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      // Synchronous: no await, no findBy. The menu is there as soon as the click returns.
      expect(screen.getAllByRole('menuitem').map(el => el.textContent)).toEqual(['CO', 'UT'])
      expect(server.calls).toHaveLength(before)
      expect(screen.getByRole('button', { name: 'Add draft bill' })).not.toHaveAttribute('aria-busy')
    })

    it('opens the two-letter field on the click itself when the tenant has no bills yet', async () => {
      const server = mockApi({ defaults: { tenantState: null }, states: [] })
      renderButton()
      await settle()
      const before = server.calls.length
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      expect(screen.getByRole('textbox', { name: 'State' })).toBeInTheDocument()
      expect(server.calls).toHaveLength(before)
    })

    it('creates a single-state tenant draft with exactly one request after the click', async () => {
      const server = mockApi({ defaults: { tenantState: 'UT' } })
      renderButton()
      await settle()
      const before = server.calls.length
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/bills/new-draft-1'))
      const after = server.calls.slice(before)
      expect(after.map(c => `${c.init?.method ?? 'GET'} ${c.path}`)).toEqual(['POST /bills/draft'])
    })

    it('a click before the prefetch lands waits on it instead of asking again', async () => {
      let release: (d: Defaults) => void = () => {}
      const server = mockApi({ defaults: () => new Promise<Defaults>(res => { release = res }), states: ['UT', 'CO'] })
      renderButton()
      await settle()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      expect(screen.queryByRole('menu')).toBeNull()
      release({ tenantState: null })
      expect(await screen.findByRole('menuitem', { name: 'CO' })).toBeInTheDocument()
      expect(server.calls.filter(c => c.path === '/bills/draft-defaults')).toHaveLength(1)
      expect(server.calls.filter(c => c.path === '/bills/draft-states')).toHaveLength(1)
    })

    it('a click before a slow prefetch of a single-state tenant still creates once it lands', async () => {
      let release: (d: Defaults) => void = () => {}
      const server = mockApi({ defaults: () => new Promise<Defaults>(res => { release = res }) })
      renderButton()
      await settle()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      expect(server.posts()).toHaveLength(0)
      release({ tenantState: 'UT' })
      await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/bills/new-draft-1'))
      expect(server.posts()).toHaveLength(1)
      expect(server.calls.filter(c => c.path === '/bills/draft-defaults')).toHaveLength(1)
    })

    it('asks again on the click when the prefetch failed, and the retry can succeed', async () => {
      let attempts = 0
      const server = mockApi({
        defaults: () => {
          attempts += 1
          if (attempts === 1) throw new api.ApiError(503, 'Central is down.')
          return { tenantState: 'UT' }
        },
      })
      renderButton()
      await settle()
      // A failed prefetch says nothing: the error would describe an attempt nobody made.
      expect(screen.queryByRole('alert')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/bills/new-draft-1'))
      expect(server.calls.filter(c => c.path === '/bills/draft-defaults')).toHaveLength(2)
    })

    it('tries a failed prefetch again when the pointer arrives, so the click can still be instant', async () => {
      let attempts = 0
      const server = mockApi({
        defaults: () => {
          attempts += 1
          if (attempts === 1) throw new api.ApiError(503, 'Central is down.')
          return { tenantState: null }
        },
        states: ['UT', 'CO'],
      })
      renderButton()
      await settle()
      fireEvent.pointerEnter(screen.getByRole('button', { name: 'Add draft bill' }), { pointerType: 'mouse' })
      await settle()
      const before = server.calls.length
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      expect(screen.getAllByRole('menuitem')).toHaveLength(2)
      expect(server.calls).toHaveLength(before)
    })

    it('does not ask again on hover or focus when the prefetch already landed', async () => {
      const server = mockApi({ defaults: { tenantState: null }, states: ['UT'] })
      renderButton()
      await settle()
      const button = screen.getByRole('button', { name: 'Add draft bill' })
      fireEvent.pointerEnter(button, { pointerType: 'mouse' })
      fireEvent.focus(button)
      await settle()
      expect(server.calls).toHaveLength(2)
    })

    it('still decides the tenant type from draft-defaults, not from the state list', async () => {
      // Two states have bills, but the tenant is configured for one: no menu.
      const server = mockApi({ defaults: { tenantState: 'UT' }, states: ['UT', 'CO'] })
      renderButton()
      await settle()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await waitFor(() => expect(server.posts()).toHaveLength(1))
      expect(screen.queryByRole('menu')).toBeNull()
      expect(server.postBodies()[0]).toBeNull()
    })

    it('sends no request on mount in a locked demo', async () => {
      demoState.demoLocked = true
      const server = mockApi()
      renderButton()
      await settle()
      expect(server.calls).toHaveLength(0)
    })

    it('shows the server error when the click retries a failed prefetch and fails again', async () => {
      const server = mockApi({ defaults: new api.ApiError(500, 'Defaults unavailable.') })
      renderButton()
      await settle()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Defaults unavailable.')
      expect(server.posts()).toHaveLength(0)
    })
  })

  describe('locked demo', () => {
    it('is disabled and sends no request when clicked', () => {
      demoState.demoLocked = true
      const server = mockApi()
      renderButton()
      const button = screen.getByRole('button', { name: 'Add draft bill' })
      expect(button).toBeDisabled()
      fireEvent.click(button)
      expect(server.calls).toHaveLength(0)
      expect(screen.getByTestId('path')).toHaveTextContent('/bills')
      expect(window.sessionStorage.length).toBe(0)
    })

    it("says \"Locked in demo mode\" in the title, as the repo's other locked controls do", () => {
      demoState.demoLocked = true
      mockApi()
      renderButton()
      const button = screen.getByRole('button', { name: 'Add draft bill' })
      expect(button).toHaveAttribute('title', 'Locked in demo mode')
      // No hover bubble is layered on a natively disabled button.
      fireEvent.pointerEnter(button, { pointerType: 'mouse' })
      expect(screen.queryByText(/before it's filed/i)).toBeNull()
    })

    it('is not disabled outside a locked demo', () => {
      mockApi()
      renderButton()
      expect(screen.getByRole('button', { name: 'Add draft bill' })).toBeEnabled()
    })
  })

  describe('errors', () => {
    it('marks nothing when the create fails', async () => {
      mockApi({ defaults: { tenantState: 'UT' }, create: () => { throw new api.ApiError(500, 'boom') } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await screen.findByRole('alert')
      expect(window.sessionStorage.length).toBe(0)
      expect(screen.getByTestId('path')).toHaveTextContent('/bills')
    })

    it("shows the server's error and does not navigate when a single-state create fails", async () => {
      const server = mockApi({
        defaults: { tenantState: 'UT' },
        create: () => { throw new api.ApiError(409, 'D1 is already used by another UT bill in 2026.') },
      })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('D1 is already used by another UT bill in 2026.')
      expect(server.posts()).toHaveLength(1)
      expect(screen.getByTestId('path')).toHaveTextContent('/bills')
      expect(screen.getByRole('button', { name: 'Add draft bill' })).toBeEnabled()
    })

    it("shows the server's error and does not navigate when a picked-state create fails", async () => {
      mockApi({
        defaults: { tenantState: null },
        states: ['UT', 'CO'],
        create: () => { throw new api.ApiError(400, 'Include a state when creating a draft.') },
      })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'CO' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Include a state when creating a draft.')
      expect(screen.getByTestId('path')).toHaveTextContent('/bills')
    })

    it('shows the error and keeps the typed state when a text-field create fails', async () => {
      mockApi({
        defaults: { tenantState: null },
        states: [],
        create: () => { throw new api.ApiError(500, 'Something broke.') },
      })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      const user = userEvent.setup()
      await user.type(await screen.findByRole('textbox', { name: 'State' }), 'ut{Enter}')
      expect(await screen.findByRole('alert')).toHaveTextContent('Something broke.')
      expect(screen.getByRole('textbox', { name: 'State' })).toHaveValue('UT')
      expect(screen.getByTestId('path')).toHaveTextContent('/bills')
    })

    it('shows a generic message when the failure is not an API error', async () => {
      mockApi({ create: () => { throw new TypeError('network down') } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Failed to create draft.')
      expect(screen.getByTestId('path')).toHaveTextContent('/bills')
    })

    it('shows an error and creates nothing when draft-defaults fails', async () => {
      const server = mockApi({ defaults: new api.ApiError(500, 'Defaults unavailable.') })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Defaults unavailable.')
      expect(server.posts()).toHaveLength(0)
      expect(screen.getByTestId('path')).toHaveTextContent('/bills')
    })

    it('clears the error on the next attempt, and the retry can succeed', async () => {
      let attempts = 0
      const server = mockApi({
        create: () => {
          attempts += 1
          if (attempts === 1) throw new api.ApiError(500, 'First try failed.')
          return { id: 'new-draft-2' }
        },
      })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await screen.findByText('First try failed.')
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/bills/new-draft-2'))
      expect(server.posts()).toHaveLength(2)
    })
  })

  describe('popup semantics and dismissal', () => {
    it('always says it opens a menu, and whether the menu is open', async () => {
      mockApi({ defaults: { tenantState: null }, states: ['UT', 'CO'] })
      renderButton()
      const button = screen.getByRole('button', { name: 'Add draft bill' })
      expect(button).toHaveAttribute('aria-haspopup', 'menu')
      expect(button).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(button)
      await screen.findByRole('menu')
      expect(button).toHaveAttribute('aria-expanded', 'true')
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      expect(button).toHaveAttribute('aria-expanded', 'false')
    })

    it('returns focus to the button on Escape from the menu', async () => {
      mockApi({ defaults: { tenantState: null }, states: ['UT', 'CO'] })
      renderButton()
      const button = screen.getByRole('button', { name: 'Add draft bill' })
      fireEvent.click(button)
      await screen.findByRole('menuitem', { name: 'CO' })
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      expect(button).toHaveFocus()
    })

    it('returns focus to the button on Escape from the text field', async () => {
      mockApi({ defaults: { tenantState: null }, states: [] })
      renderButton()
      const button = screen.getByRole('button', { name: 'Add draft bill' })
      fireEvent.click(button)
      const field = await screen.findByRole('textbox', { name: 'State' })
      fireEvent.keyDown(field, { key: 'Escape' })
      expect(button).toHaveFocus()
    })

    // A failed create leaves the picker open with the error beside the button;
    // dismissing the picker then clears the stale error.
    async function openPickerWithFailedCreate() {
      mockApi({
        defaults: { tenantState: null },
        states: [],
        create: () => { throw new api.ApiError(500, 'Something broke.') },
      })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      const user = userEvent.setup()
      await user.type(await screen.findByRole('textbox', { name: 'State' }), 'ut{Enter}')
      await screen.findByRole('alert')
    }

    it('clears the error when the picker is dismissed with Escape', async () => {
      await openPickerWithFailedCreate()
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'State' }), { key: 'Escape' })
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('clears the error when the picker is dismissed by a click outside', async () => {
      await openPickerWithFailedCreate()
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('clears the error when the button closes the picker', async () => {
      await openPickerWithFailedCreate()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByRole('textbox', { name: 'State' })).toBeNull()
    })

    it('lets a long error message wrap instead of overflowing the header', async () => {
      mockApi({ create: () => { throw new api.ApiError(500, 'x'.repeat(300)) } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      const alert = await screen.findByRole('alert')
      expect(alert.style.minWidth).toBe('0px')
      expect(alert.style.overflowWrap).toBe('anywhere')
    })
  })

  describe('look and hover', () => {
    it('is set in the view switcher\'s size, so the two sit on one baseline', () => {
      mockApi()
      renderButton()
      const style = screen.getByRole('button', { name: 'Add draft bill' }).style
      // The Views trigger: fontSize.base, 3px vertical padding, the inherited font and line height.
      expect(style.fontSize).toBe(`${fontSize.base}px`)
      expect(style.paddingTop).toBe('3px')
      expect(style.paddingBottom).toBe('3px')
      expect(style.fontFamily).toBe('inherit')
      expect(style.lineHeight).toBe('')
    })

    it('is lighter in weight than the view switcher, in the same secondary text color', () => {
      mockApi()
      renderButton()
      const style = screen.getByRole('button', { name: 'Add draft bill' }).style
      expect(Number(style.fontWeight)).toBe(fontWeight.normal)
      expect(Number(style.fontWeight)).toBeLessThan(fontWeight.medium)
      expect(style.color).toBe(color.textSecondary)
    })

    it('keeps WCAG AA (4.5:1) for its text on the page header in both color modes', () => {
      // The header behind the button is surfaceMuted (BillList's sticky block). 14px regular is normal-size text.
      for (const mode of ['light', 'dark'] as const) {
        const fg = resolveColor(color.textSecondary, mode)
        const bg = resolveColor(color.surfaceMuted, mode)
        expect(contrast(fg, bg), mode).toBeGreaterThanOrEqual(4.5)
      }
    })

    it('explains the feature on hover', () => {
      mockApi()
      renderButton()
      fireEvent.pointerEnter(screen.getByRole('button', { name: 'Add draft bill' }), { pointerType: 'mouse' })
      expect(screen.getByText(
        "Track a bill before it's filed. Link it to the filed bill later to carry over its votes, comments, and notes.",
      )).toBeInTheDocument()
    })

    it('is a quiet text button: no fill, no border', () => {
      mockApi()
      renderButton()
      const button = screen.getByRole('button', { name: 'Add draft bill' })
      expect(button.style.background).toBe('none')
      expect(button.style.borderStyle).toBe('none')
    })
  })
})
