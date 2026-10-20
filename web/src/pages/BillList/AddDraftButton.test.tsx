import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { AddDraftButton } from './AddDraftButton'
import { peekJustCreatedDraft } from '../../lib/justCreatedDraft'
import * as api from '../../lib/api'

// Mutable flag so a test can opt into a locked demo without a module-level
// mock rewrite (same pattern as DraftBills.test.tsx).
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
  defaults?: Defaults | Error
  facets?: { state: Record<string, number> } | Error
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
      return d as never
    }
    if (path === '/bills/facets') {
      const f = server.facets ?? { state: {} }
      if (f instanceof Error) throw f
      return f as never
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
      mockApi({ defaults: { tenantState: 'UT' }, facets: { state: { UT: 3, CO: 1 } } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/bills/new-draft-1'))
      expect(screen.queryByRole('menu')).toBeNull()
      expect(screen.queryByLabelText(/state/i)).toBeNull()
    })

    it('decides single-state from draft-defaults, not from how many states have bills', async () => {
      // Two states have bills, but the tenant is configured for one: still one click.
      const server = mockApi({ defaults: { tenantState: 'UT' }, facets: { state: { UT: 3, CO: 1 } } })
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
      const server = mockApi({ defaults: { tenantState: null }, facets: { state: { UT: 3, CO: 1 } } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))

      expect(await screen.findByRole('menuitem', { name: 'CO' })).toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: 'UT' })).toBeInTheDocument()
      expect(server.posts()).toHaveLength(0)
      expect(screen.getByTestId('path')).toHaveTextContent('/bills')
    })

    it('lists the states in alphabetical order', async () => {
      mockApi({ defaults: { tenantState: null }, facets: { state: { UT: 3, CO: 1, AZ: 2 } } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await screen.findByRole('menuitem', { name: 'AZ' })
      expect(screen.getAllByRole('menuitem').map(el => el.textContent)).toEqual(['AZ', 'CO', 'UT'])
    })

    it('creates the draft in the picked state and opens its page marked as just created', async () => {
      const server = mockApi({ defaults: { tenantState: null }, facets: { state: { UT: 3, CO: 1 } } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'CO' }))

      await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/bills/new-draft-1'))
      expect(server.postBodies()).toEqual([{ state: 'CO' }])
      expect(peekJustCreatedDraft('new-draft-1')).toBe(true)
    })

    it('still offers the menu when only one state has bills', async () => {
      // One state with bills does not make the tenant single-state: draft-defaults says null.
      const server = mockApi({ defaults: { tenantState: null }, facets: { state: { UT: 3 } } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      expect(await screen.findByRole('menuitem', { name: 'UT' })).toBeInTheDocument()
      expect(server.posts()).toHaveLength(0)
    })

    it('closes the menu on Escape without creating anything', async () => {
      const server = mockApi({ defaults: { tenantState: null }, facets: { state: { UT: 3, CO: 1 } } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await screen.findByRole('menuitem', { name: 'CO' })
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
      expect(server.posts()).toHaveLength(0)
    })

    it('closes the menu on a click outside it without creating anything', async () => {
      const server = mockApi({ defaults: { tenantState: null }, facets: { state: { UT: 3, CO: 1 } } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await screen.findByRole('menuitem', { name: 'CO' })
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('menu')).toBeNull()
      expect(server.posts()).toHaveLength(0)
    })

    it('closes the menu when the button is clicked again', async () => {
      mockApi({ defaults: { tenantState: null }, facets: { state: { UT: 3, CO: 1 } } })
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
      mockApi({ defaults: { tenantState: null }, facets: { state: {} } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      const field = await screen.findByRole('textbox', { name: 'State' })
      expect(field).toHaveAttribute('maxlength', '2')
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('creates the draft with the typed state, uppercased', async () => {
      const server = mockApi({ defaults: { tenantState: null }, facets: { state: {} } })
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
      const server = mockApi({ defaults: { tenantState: null }, facets: { state: {} } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      const user = userEvent.setup()
      await user.type(await screen.findByRole('textbox', { name: 'State' }), 'co{Enter}')
      await waitFor(() => expect(server.postBodies()).toEqual([{ state: 'CO' }]))
    })

    it('does not create with a blank state', async () => {
      const server = mockApi({ defaults: { tenantState: null }, facets: { state: {} } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      await screen.findByRole('textbox', { name: 'State' })
      fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
      expect(server.posts()).toHaveLength(0)
      expect(screen.getByTestId('path')).toHaveTextContent('/bills')
    })

    it('does not create with a one-letter state', async () => {
      const server = mockApi({ defaults: { tenantState: null }, facets: { state: {} } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      const user = userEvent.setup()
      await user.type(await screen.findByRole('textbox', { name: 'State' }), 'u{Enter}')
      fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
      expect(server.posts()).toHaveLength(0)
    })

    it('does not accept more than two letters or non-letters', async () => {
      const server = mockApi({ defaults: { tenantState: null }, facets: { state: {} } })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      const user = userEvent.setup()
      const field = await screen.findByRole('textbox', { name: 'State' })
      await user.type(field, '1u2tx{Enter}')
      expect(field).toHaveValue('UT')
      await waitFor(() => expect(server.postBodies()).toEqual([{ state: 'UT' }]))
    })

    it('falls back to the text field when the facets call fails', async () => {
      mockApi({ defaults: { tenantState: null }, facets: new api.ApiError(500, 'boom') })
      renderButton()
      fireEvent.click(screen.getByRole('button', { name: 'Add draft bill' }))
      expect(await screen.findByRole('textbox', { name: 'State' })).toBeInTheDocument()
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
        facets: { state: { UT: 3, CO: 1 } },
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
        facets: { state: {} },
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
      mockApi({ defaults: { tenantState: null }, facets: { state: { UT: 3, CO: 1 } } })
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
      mockApi({ defaults: { tenantState: null }, facets: { state: { UT: 3, CO: 1 } } })
      renderButton()
      const button = screen.getByRole('button', { name: 'Add draft bill' })
      fireEvent.click(button)
      await screen.findByRole('menuitem', { name: 'CO' })
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      expect(button).toHaveFocus()
    })

    it('returns focus to the button on Escape from the text field', async () => {
      mockApi({ defaults: { tenantState: null }, facets: { state: {} } })
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
        facets: { state: {} },
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
