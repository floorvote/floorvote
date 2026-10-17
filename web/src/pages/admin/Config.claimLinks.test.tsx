import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, act } from '@testing-library/react'
import React from 'react'
import userEvent from '@testing-library/user-event'

// The claim links toggle in Settings (#570), in the AI instructions card.

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) =>
    React.createElement('a', { href: to }, children),
}))
vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message) }
  },
}))
vi.mock('../../hooks/usePageTitle', () => ({ usePageTitle: () => {} }))
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'a@b.com', name: 'Admin', role: 'admin' }, loading: false }),
}))
const { demo } = vi.hoisted(() => ({ demo: { demoMode: false, demoLocked: false } }))
vi.mock('../../context/DemoContext', () => ({ useDemo: () => demo }))
vi.mock('../../components/SettingsNav', () => ({
  SettingsNav: () => React.createElement('div', { 'data-testid': 'settings-nav' }),
}))
vi.mock('../../components/ResizableTextarea', () => ({
  ResizableTextarea: ({ value, onChange, ...rest }: React.ComponentProps<'textarea'>) =>
    React.createElement('textarea', { value, onChange, ...rest }),
}))
vi.mock('../../components/HintText', () => ({
  HintText: ({ text }: { text: string }) => React.createElement('span', null, text),
}))
vi.mock('../../components/RichTextEditor', () => ({
  RichTextEditor: () => React.createElement('div', { 'data-testid': 'rich-text-editor' }),
}))
vi.mock('../../components/BillBadge', () => ({ BillBadge: () => null }))
vi.mock('../../lib/exportData', () => ({ exportAllData: vi.fn() }))

import { apiFetch } from '../../lib/api'
import { Config } from './Config'
import { createUnsavedRegistry, UnsavedTextContext } from '../../lib/unsavedText'

const mockFetch = vi.mocked(apiFetch)

const BASE_CONFIG = {
  keywords: [],
  association_name: 'Test Org',
  ai_context: '',
  relevance_question: '',
  tag_taxonomy: [] as { name: string; description?: string }[],
  matched_bills_count: 0,
  prioritized_bills_count: 0,
}

function mockConfig(extra: Record<string, unknown> = {}, onClaimLinks?: (body: unknown) => unknown) {
  mockFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/admin/config') return { ...BASE_CONFIG, ...extra }
    if (path === '/admin/custom-fields') return []
    if (path === '/bills/drafts') return { drafts: [] }
    if (path === '/admin/claim-links' && init?.method === 'PUT') {
      return onClaimLinks ? onClaimLinks(JSON.parse(init.body as string)) : { enabled: false }
    }
    throw new Error('unexpected path: ' + path)
  })
}

function renderConfig() {
  render(<UnsavedTextContext.Provider value={createUnsavedRegistry()}><Config /></UnsavedTextContext.Provider>)
}

const toggle = () => screen.findByRole('checkbox', { name: /link summary claims to the bill text/i })
const putsToClaimLinks = () => mockFetch.mock.calls.filter(([p, init]) => p === '/admin/claim-links' && (init as RequestInit | undefined)?.method === 'PUT')

beforeEach(() => {
  vi.resetAllMocks()
  demo.demoLocked = false
  mockConfig()
})

describe('Config: the claim links toggle', () => {
  it('sits in the AI instructions card', async () => {
    renderConfig()
    const box = await toggle()
    const card = screen.getByRole('heading', { name: 'AI instructions' }).parentElement as HTMLElement
    expect(card).toContainElement(box)
  })

  it('is on for an instance whose config says nothing about it', async () => {
    renderConfig()
    expect(await toggle()).toBeChecked()
  })

  it('is on when the config says on', async () => {
    mockConfig({ claim_links_enabled: true })
    renderConfig()
    expect(await toggle()).toBeChecked()
  })

  it('shows off when an admin has turned it off', async () => {
    mockConfig({ claim_links_enabled: false })
    renderConfig()
    expect(await toggle()).not.toBeChecked()
  })

  it('says it may increase AI costs slightly, and gives no figure', async () => {
    renderConfig()
    const box = await toggle()
    const card = (screen.getByRole('heading', { name: 'AI instructions' }).parentElement as HTMLElement)
    const copy = within(card).getByTestId('claim-links-copy').textContent ?? ''
    expect(box).toBeTruthy()
    expect(copy).toMatch(/may increase (your )?AI costs slightly/i)
    // No dollar amount, cents, token count, or percentage in the app.
    expect(copy).not.toMatch(/[$¢%]/)
    expect(copy).not.toMatch(/\d/)
    expect(copy).not.toMatch(/\b(dollars?|cents?|tokens?)\b/i)
  })

  it('explains what off does and that turning it back on shows stored links', async () => {
    renderConfig()
    await toggle()
    const copy = screen.getByTestId('claim-links-copy').textContent ?? ''
    expect(copy).toMatch(/plain text/i)
    expect(copy).toMatch(/back on/i)
  })

  it('saves off right away through the claim links route, not the AI instructions save', async () => {
    renderConfig()
    const box = await toggle()
    await userEvent.click(box)
    await waitFor(() => expect(putsToClaimLinks()).toHaveLength(1))
    expect(JSON.parse((putsToClaimLinks()[0][1] as RequestInit).body as string)).toEqual({ enabled: false })
    expect(box).not.toBeChecked()
    expect(mockFetch.mock.calls.some(([p, init]) => p === '/admin/config' && (init as RequestInit | undefined)?.method === 'PUT')).toBe(false)
  })

  it('saves on again when turned back on', async () => {
    mockConfig({ claim_links_enabled: false }, () => ({ enabled: true }))
    renderConfig()
    const box = await toggle()
    await userEvent.click(box)
    await waitFor(() => expect(putsToClaimLinks()).toHaveLength(1))
    expect(JSON.parse((putsToClaimLinks()[0][1] as RequestInit).body as string)).toEqual({ enabled: true })
    expect(box).toBeChecked()
  })

  it('does not touch the unsaved AI instructions being edited', async () => {
    renderConfig()
    const box = await toggle()
    const summary = await screen.findByLabelText('Bill summary')
    await userEvent.type(summary, 'Draft instructions')
    await userEvent.click(box)
    await waitFor(() => expect(putsToClaimLinks()).toHaveLength(1))
    expect((summary as HTMLTextAreaElement).value).toBe('Draft instructions')
  })

  it('shows who changed it and when, from the response', async () => {
    mockConfig({}, () => ({
      enabled: false,
      changedAt: '2026-10-20 14:05:09',
      changedBy: { id: 'u9', name: 'Avery Admin', email: 'avery@example.com' },
    }))
    renderConfig()
    await userEvent.click(await toggle())
    await waitFor(() => expect(screen.getByTestId('claim-links-changed')).toHaveTextContent(/Avery Admin/))
    expect(screen.getByTestId('claim-links-changed')).toHaveTextContent(/October 20, 2026/)
  })

  it('shows who last changed it, as loaded with the settings', async () => {
    mockConfig({
      claim_links_enabled: false,
      claim_links_changed_at: '2026-10-20 14:05:09',
      claim_links_changed_by: { id: 'u9', name: null, email: 'avery@example.com' },
    })
    renderConfig()
    await toggle()
    // A member with no name is shown by email.
    expect(screen.getByTestId('claim-links-changed')).toHaveTextContent(/avery@example\.com/)
  })

  it('shows no change line for an instance nobody has changed it on', async () => {
    renderConfig()
    await toggle()
    expect(screen.queryByTestId('claim-links-changed')).toBeNull()
  })

  it('puts the box back and shows the error when the save fails', async () => {
    const { ApiError } = await import('../../lib/api')
    mockConfig({}, () => { throw new ApiError(500, 'Could not save claim links.') })
    renderConfig()
    const box = await toggle()
    await userEvent.click(box)
    expect(await screen.findByText('Could not save claim links.')).toBeInTheDocument()
    expect(box).toBeChecked()
  })

  it('is disabled on a locked demo, which cannot change settings', async () => {
    demo.demoLocked = true
    renderConfig()
    expect(await toggle()).toBeDisabled()
  })
})

describe('Config: the claim links toggle, for keyboard and screen reader users', () => {
  /** A save that stays in flight until the test settles it. */
  function pendingSave() {
    let settle!: (v: unknown) => void
    let fail!: (e: unknown) => void
    const promise = new Promise((res, rej) => { settle = res; fail = rej })
    mockConfig({}, () => promise)
    return { settle, fail }
  }

  it('keeps focus on the checkbox through a keyboard toggle and its save', async () => {
    const save = pendingSave()
    renderConfig()
    const box = await toggle()
    box.focus()
    await userEvent.keyboard(' ')
    await waitFor(() => expect(putsToClaimLinks()).toHaveLength(1))
    // In flight: still the focused element, and not natively disabled, which is what drops focus.
    expect(document.activeElement).toBe(box)
    expect(box).not.toBeDisabled()
    expect(box).toHaveAttribute('aria-disabled', 'true')
    await act(async () => { save.settle({ enabled: false, changedAt: '2026-10-20 14:05:09', changedBy: null }) })
    expect(document.activeElement).toBe(box)
    expect(box).toHaveAttribute('aria-disabled', 'false')
  })

  it('ignores a second toggle while the first save is in flight', async () => {
    const save = pendingSave()
    renderConfig()
    const box = await toggle()
    box.focus()
    await userEvent.keyboard(' ')
    await waitFor(() => expect(putsToClaimLinks()).toHaveLength(1))
    await userEvent.keyboard(' ')
    await userEvent.click(box)
    expect(putsToClaimLinks()).toHaveLength(1)
    expect(box).not.toBeChecked()
    await act(async () => { save.settle({ enabled: false }) })
    expect(putsToClaimLinks()).toHaveLength(1)
    expect(box).not.toBeChecked()
  })

  it('takes a toggle again once the save is done', async () => {
    mockConfig({}, (body) => ({ enabled: (body as { enabled: boolean }).enabled }))
    renderConfig()
    const box = await toggle()
    await userEvent.click(box)
    await waitFor(() => expect(box).toHaveAttribute('aria-disabled', 'false'))
    await userEvent.click(box)
    await waitFor(() => expect(putsToClaimLinks()).toHaveLength(2))
    expect(box).toBeChecked()
  })

  it('announces a saved change in a polite live region', async () => {
    mockConfig({}, () => ({ enabled: false }))
    renderConfig()
    await userEvent.click(await toggle())
    const status = screen.getByTestId('claim-links-status')
    expect(status).toHaveAttribute('role', 'status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    await waitFor(() => expect(status).toHaveTextContent(/claim links turned off/i))
  })

  it('announces that claim links are back on after turning them on', async () => {
    mockConfig({ claim_links_enabled: false }, () => ({ enabled: true }))
    renderConfig()
    await userEvent.click(await toggle())
    await waitFor(() => expect(screen.getByTestId('claim-links-status')).toHaveTextContent(/claim links turned on/i))
  })

  it('announces a failed save in the live region', async () => {
    const { ApiError } = await import('../../lib/api')
    mockConfig({}, () => { throw new ApiError(500, 'Could not save claim links.') })
    renderConfig()
    await userEvent.click(await toggle())
    await waitFor(() => expect(screen.getByTestId('claim-links-status')).toHaveTextContent('Could not save claim links.'))
  })

  it('has the live region in place before anything is announced, empty', async () => {
    renderConfig()
    await toggle()
    expect(screen.getByTestId('claim-links-status')).toBeEmptyDOMElement()
  })
})
