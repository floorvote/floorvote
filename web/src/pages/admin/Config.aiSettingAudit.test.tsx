import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import userEvent from '@testing-library/user-event'

// "Last changed by ... on ..." beside each AI setting (#602), from the admin config.

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
const AVERY = { id: 'u9', name: 'Avery Admin', email: 'avery@example.com' }

function mockConfig(extra: Record<string, unknown> = {}, onPut?: (body: Record<string, unknown>) => unknown) {
  mockFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/admin/config' && init?.method === 'PUT') {
      return onPut ? onPut(JSON.parse(init.body as string)) : { ok: true }
    }
    if (path === '/admin/config') return { ...BASE_CONFIG, ...extra }
    if (path === '/admin/custom-fields') return []
    if (path === '/bills/drafts') return { drafts: [] }
    throw new Error('unexpected path: ' + path)
  })
}

function renderConfig() {
  render(<UnsavedTextContext.Provider value={createUnsavedRegistry()}><Config /></UnsavedTextContext.Provider>)
}

const IDS = ['ai-context-changed', 'relevance-question-changed', 'tag-taxonomy-changed'] as const

beforeEach(() => {
  vi.resetAllMocks()
  demo.demoLocked = false
  mockConfig()
})

describe('Config: who last changed each AI setting', () => {
  it('shows the person and the date beside each of the three settings', async () => {
    mockConfig({
      ai_context_changed_at: '2026-10-20 14:05:09',
      ai_context_changed_by: AVERY,
      relevance_question_changed_at: '2026-10-21 09:00:00',
      relevance_question_changed_by: { id: 'u8', name: 'Olive Owner', email: 'owner@example.com' },
      tag_taxonomy_changed_at: '2026-10-22 10:30:00',
      tag_taxonomy_changed_by: { id: 'u7', name: 'Sam Steward', email: 'sam@example.com' },
    })
    renderConfig()
    const summary = await screen.findByTestId('ai-context-changed')
    expect(summary.textContent).toMatch(/Last changed by Avery Admin on October 20, 2026/)
    expect(screen.getByTestId('relevance-question-changed').textContent).toMatch(/Last changed by Olive Owner on October 2[01], 2026/)
    expect(screen.getByTestId('tag-taxonomy-changed').textContent).toMatch(/Last changed by Sam Steward on October 22, 2026/)
  })

  it('puts each record in its own setting\'s field', async () => {
    mockConfig({
      ai_context_changed_at: '2026-10-20 14:05:09', ai_context_changed_by: AVERY,
      relevance_question_changed_at: '2026-10-21 14:05:09', relevance_question_changed_by: AVERY,
      tag_taxonomy_changed_at: '2026-10-22 14:05:09', tag_taxonomy_changed_by: AVERY,
    })
    renderConfig()
    const summary = await screen.findByLabelText('Bill summary')
    const relevance = screen.getByLabelText('Relevance score')
    const ctx = screen.getByTestId('ai-context-changed')
    const rel = screen.getByTestId('relevance-question-changed')
    const tags = screen.getByTestId('tag-taxonomy-changed')
    const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(summary, ctx)).toBe(true)
    expect(follows(ctx, relevance)).toBe(true)
    expect(follows(relevance, rel)).toBe(true)
    expect(follows(rel, tags)).toBe(true)
    expect(follows(screen.getByTestId('tag-count'), tags)).toBe(true)
  })

  it('shows a setting\'s record only beside that setting', async () => {
    mockConfig({ relevance_question_changed_at: '2026-10-21 09:00:00', relevance_question_changed_by: AVERY })
    renderConfig()
    await screen.findByTestId('relevance-question-changed')
    expect(screen.queryByTestId('ai-context-changed')).toBeNull()
    expect(screen.queryByTestId('tag-taxonomy-changed')).toBeNull()
    expect(screen.getAllByText(/last changed/i)).toHaveLength(1)
  })

  it('shows nothing for a setting that was never changed, not a placeholder name', async () => {
    renderConfig()
    await screen.findByLabelText('Bill summary')
    for (const id of IDS) expect(screen.queryByTestId(id)).toBeNull()
    expect(screen.queryByText(/last changed/i)).toBeNull()
    expect(screen.queryByText(/unknown|nobody|n\/a/i)).toBeNull()
  })

  it('shows nothing when only a person is given without a time', async () => {
    mockConfig({ ai_context_changed_by: AVERY })
    renderConfig()
    await screen.findByLabelText('Bill summary')
    expect(screen.queryByTestId('ai-context-changed')).toBeNull()
  })

  it('uses a neutral label when the person was removed, and still shows the date', async () => {
    mockConfig({ ai_context_changed_at: '2026-10-20 14:05:09', ai_context_changed_by: null })
    renderConfig()
    const line = await screen.findByTestId('ai-context-changed')
    expect(line.textContent).toMatch(/Last changed by a removed user on October 20, 2026/)
    expect(screen.queryByText(/null|undefined|error/i)).toBeNull()
  })

  it('falls back to the email when the person has no name', async () => {
    mockConfig({ ai_context_changed_at: '2026-10-20 14:05:09', ai_context_changed_by: { id: 'u9', name: null, email: 'avery@example.com' } })
    renderConfig()
    expect((await screen.findByTestId('ai-context-changed')).textContent).toMatch(/Last changed by avery@example.com on/)
  })

  it('shows nothing for the claim links setting, as #570 decided', async () => {
    mockConfig({ claim_links_enabled: false, claim_links_changed_at: '2026-10-20 14:05:09', claim_links_changed_by: AVERY })
    renderConfig()
    await screen.findByRole('switch', { name: /claim links/i })
    expect(screen.queryByText(/last changed/i)).toBeNull()
  })

  it('updates the record after a save that changed a setting, from the save response', async () => {
    mockConfig({}, () => ({
      ok: true,
      ai_context_changed_at: '2026-10-25 08:00:00',
      ai_context_changed_by: AVERY,
    }))
    renderConfig()
    const summary = await screen.findByLabelText('Bill summary')
    await userEvent.type(summary, 'New instructions')
    await userEvent.click(screen.getByRole('button', { name: 'Save AI instructions' }))
    const line = await screen.findByTestId('ai-context-changed')
    expect(line.textContent).toMatch(/Last changed by Avery Admin on October 2[45], 2026/)
    expect(screen.queryByTestId('relevance-question-changed')).toBeNull()
  })

  it('keeps the old record when a save changes nothing', async () => {
    mockConfig({ ai_context: 'Same.', ai_context_changed_at: '2026-10-20 14:05:09', ai_context_changed_by: AVERY },
      () => ({ ok: true }))
    renderConfig()
    await screen.findByTestId('ai-context-changed')
    await userEvent.click(screen.getByRole('button', { name: 'Save AI instructions' }))
    await waitFor(() => expect(mockFetch.mock.calls.some(([p, i]) => p === '/admin/config' && (i as RequestInit | undefined)?.method === 'PUT')).toBe(true))
    expect(screen.getByTestId('ai-context-changed').textContent).toMatch(/Avery Admin on October 20, 2026/)
  })
})
