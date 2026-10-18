import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, act } from '@testing-library/react'
import React from 'react'
import userEvent from '@testing-library/user-event'

// The claim links switch in Settings (#570), in the AI instructions card, right under the bill summary instructions.

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
  matched_bills_count: 7,
  prioritized_bills_count: 3,
}

function mockConfig(extra: Record<string, unknown> = {}, onClaimLinks?: (body: unknown) => unknown) {
  mockFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/admin/config') return { ...BASE_CONFIG, ...extra }
    if (path === '/admin/custom-fields') return []
    if (path === '/bills/drafts') return { drafts: [] }
    if (path.startsWith('/admin/reprocess-llm-all') && init?.method === 'POST') return { queued: 3 }
    if (path === '/admin/claim-links' && init?.method === 'PUT') {
      return onClaimLinks ? onClaimLinks(JSON.parse(init.body as string)) : { enabled: false }
    }
    throw new Error('unexpected path: ' + path)
  })
}

function renderConfig() {
  render(<UnsavedTextContext.Provider value={createUnsavedRegistry()}><Config /></UnsavedTextContext.Provider>)
}

const COPY = "Links claims in a bill's summary to the associated passage in the bill. This will increase AI costs slightly."
const toggle = () => screen.findByRole('switch', { name: /claim links/i })
const putsToClaimLinks = () => mockFetch.mock.calls.filter(([p, init]) => p === '/admin/claim-links' && (init as RequestInit | undefined)?.method === 'PUT')
const reprocessPosts = () => mockFetch.mock.calls.filter(([p, init]) => String(p).startsWith('/admin/reprocess-llm-all') && (init as RequestInit | undefined)?.method === 'POST')
const scopeDialog = () => screen.findByRole('dialog', { name: /claim links turned on/i })

beforeEach(() => {
  vi.resetAllMocks()
  demo.demoLocked = false
  mockConfig()
})

describe('Config: the claim links switch', () => {
  it('sits in the AI instructions card', async () => {
    renderConfig()
    const box = await toggle()
    const card = screen.getByRole('heading', { name: 'AI instructions' }).parentElement as HTMLElement
    expect(card).toContainElement(box)
  })

  it('is a switch, not a checkbox', async () => {
    renderConfig()
    await toggle()
    expect(screen.queryByRole('checkbox', { name: /claim/i })).toBeNull()
  })

  it('sits directly under the bill summary instructions, before the relevance score', async () => {
    renderConfig()
    const box = await toggle()
    const summary = await screen.findByLabelText('Bill summary')
    const relevance = screen.getByLabelText('Relevance score')
    expect(summary.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(box.compareDocumentPosition(relevance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // And after the summary's own hint, so it reads as part of that field.
    const hint = screen.getByText(/system instructions sent to the ai for every bill/i)
    expect(hint.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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

  it('has exactly the agreed description', async () => {
    renderConfig()
    await toggle()
    expect(screen.getByTestId('claim-links-copy').textContent).toBe(COPY)
  })

  it('has a short label', async () => {
    renderConfig()
    await toggle()
    expect(screen.getByTestId('claim-links-label').textContent).toBe('Claim links')
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

  it('shows no changed-by or changed-at text, however the settings come back', async () => {
    mockConfig({
      claim_links_enabled: false,
      claim_links_changed_at: '2026-10-20 14:05:09',
      claim_links_changed_by: { id: 'u9', name: 'Avery Admin', email: 'avery@example.com' },
    }, () => ({
      enabled: true,
      changedAt: '2026-10-21 09:00:00',
      changedBy: { id: 'u9', name: 'Avery Admin', email: 'avery@example.com' },
    }))
    renderConfig()
    const box = await toggle()
    expect(screen.queryByText(/last changed/i)).toBeNull()
    expect(screen.queryByTestId('claim-links-changed')).toBeNull()
    await userEvent.click(box)
    await waitFor(() => expect(putsToClaimLinks()).toHaveLength(1))
    expect(screen.queryByText(/last changed/i)).toBeNull()
    expect(screen.queryByText(/Avery Admin/)).toBeNull()
    expect(screen.queryByText(/October 2\d, 2026/)).toBeNull()
  })

  it('puts the switch back and shows the error when the save fails', async () => {
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

describe('Config: turning claim links on offers a re-run', () => {
  async function turnOn() {
    mockConfig({ claim_links_enabled: false }, () => ({ enabled: true }))
    renderConfig()
    await userEvent.click(await toggle())
  }

  it('opens the reprocess dialog with the claim links intro', async () => {
    await turnOn()
    const dialog = await scopeDialog()
    expect(within(dialog).getByText(/existing summaries get claim links only when/i)).toBeInTheDocument()
    expect(within(dialog).queryByText(/instructions you just saved/i)).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Instructions saved' })).toBeNull()
  })

  it('offers prioritized and all bills, and a way to decline', async () => {
    await turnOn()
    const dialog = await scopeDialog()
    expect(within(dialog).getByRole('button', { name: /all 3 prioritized bills/i })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /all 7 fully analyzed bills/i })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /no, just future bill texts/i })).toBeInTheDocument()
  })

  it('posts the prioritized scope when that is chosen', async () => {
    await turnOn()
    const dialog = await scopeDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: /prioritized bills/i }))
    await waitFor(() => expect(reprocessPosts()).toHaveLength(1))
    expect(reprocessPosts()[0][0]).toBe('/admin/reprocess-llm-all?scope=prioritized')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('posts the all scope when that is chosen', async () => {
    await turnOn()
    const dialog = await scopeDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: /fully analyzed bills/i }))
    await waitFor(() => expect(reprocessPosts()).toHaveLength(1))
    expect(reprocessPosts()[0][0]).toBe('/admin/reprocess-llm-all?scope=all')
  })

  it('posts nothing when dismissed', async () => {
    await turnOn()
    const dialog = await scopeDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: /no, just future bill texts/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(reprocessPosts()).toHaveLength(0)
  })

  it('opens nothing when turned off', async () => {
    mockConfig({}, () => ({ enabled: false }))
    renderConfig()
    const box = await toggle()
    await userEvent.click(box)
    await waitFor(() => expect(putsToClaimLinks()).toHaveLength(1))
    expect(box).not.toBeChecked()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens nothing when the save fails, and puts the switch back', async () => {
    const { ApiError } = await import('../../lib/api')
    mockConfig({ claim_links_enabled: false }, () => { throw new ApiError(500, 'Could not save claim links.') })
    renderConfig()
    const box = await toggle()
    await userEvent.click(box)
    expect(await screen.findByText('Could not save claim links.')).toBeInTheDocument()
    expect(box).not.toBeChecked()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not open before the save has succeeded', async () => {
    let settle!: (v: unknown) => void
    const promise = new Promise((res) => { settle = res })
    mockConfig({ claim_links_enabled: false }, () => promise)
    renderConfig()
    await userEvent.click(await toggle())
    await waitFor(() => expect(putsToClaimLinks()).toHaveLength(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { settle({ enabled: true }) })
    expect(await scopeDialog()).toBeInTheDocument()
  })

  it('has nothing to re-run on an instance with no fully analyzed bills, so opens nothing', async () => {
    mockConfig({ claim_links_enabled: false, matched_bills_count: 0, prioritized_bills_count: 0 }, () => ({ enabled: true }))
    renderConfig()
    const box = await toggle()
    await userEvent.click(box)
    await waitFor(() => expect(box).toBeChecked())
    await waitFor(() => expect(putsToClaimLinks()).toHaveLength(1))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('still opens the usual instructions dialog, with its own text, after saving instructions', async () => {
    mockConfig({ ai_context: 'Original instructions' })
    renderConfig()
    const summary = await screen.findByLabelText('Bill summary')
    await userEvent.clear(summary)
    await userEvent.type(summary, 'Different instructions')
    mockFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/admin/config' && init?.method === 'PUT') return { queued: 0 }
      throw new Error('unexpected path: ' + path)
    })
    await userEvent.click(screen.getByRole('button', { name: 'Save AI instructions' }))
    expect(await screen.findByRole('dialog', { name: 'Instructions saved' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /claim links turned on/i })).toBeNull()
  })
})

describe('Config: the claim links switch, for keyboard and screen reader users', () => {
  /** A save that stays in flight until the test settles it. */
  function pendingSave() {
    let settle!: (v: unknown) => void
    let fail!: (e: unknown) => void
    const promise = new Promise((res, rej) => { settle = res; fail = rej })
    mockConfig({}, () => promise)
    return { settle, fail }
  }

  it('keeps focus on the switch through a keyboard toggle and its save', async () => {
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
    await act(async () => { save.settle({ enabled: false }) })
    expect(document.activeElement).toBe(box)
    expect(box).not.toHaveAttribute('aria-disabled', 'true')
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
    await waitFor(() => expect(box).not.toHaveAttribute('aria-disabled', 'true'))
    // Turning it back on opens the re-run dialog, which is dismissed here.
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
