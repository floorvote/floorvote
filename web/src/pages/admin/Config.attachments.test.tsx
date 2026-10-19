import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

// The summary citations switch in Settings (#570, internally "claim links"), in the AI instructions card, right under the bill summary instructions, in a box like the notification switches.

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
const GB = 1024 ** 3

// The attachment storage card (#465) sits on the Settings page between Custom fields and Labels.
function mockConfig(usage: unknown) {
  mockFetch.mockImplementation(async (path: string) => {
    if (path === '/admin/config') return { keywords: [], association_name: 'Test Org', ai_context: '', relevance_question: '', tag_taxonomy: [], matched_bills_count: 0, prioritized_bills_count: 0 }
    if (path === '/admin/custom-fields') return []
    if (path === '/bills/drafts') return { drafts: [] }
    if (path === '/attachments/usage') return usage
    throw new Error('unexpected path: ' + path)
  })
}

function renderConfig() {
  render(<UnsavedTextContext.Provider value={createUnsavedRegistry()}><Config /></UnsavedTextContext.Provider>)
}

beforeEach(() => { vi.resetAllMocks() })

describe('Config: attachment storage', () => {
  it('shows the storage card between Custom fields and Labels when attachments are on', async () => {
    mockConfig({ enabled: true, usedBytes: 2 * GB, quotaBytes: 5 * GB })
    renderConfig()
    const heading = await screen.findByRole('heading', { name: 'File attachments' })
    const custom = screen.getByRole('heading', { name: 'Custom fields' })
    const labels = screen.getByRole('heading', { name: 'Labels' })
    expect(custom.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(heading.compareDocumentPosition(labels) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('2 GB of 5 GB used')).toBeInTheDocument()
  })

  it('has no storage card when attachments are off', async () => {
    mockConfig({ enabled: false, usedBytes: 0, quotaBytes: 5 * GB })
    renderConfig()
    await screen.findByRole('heading', { name: 'Labels' })
    expect(screen.queryByRole('heading', { name: 'File attachments' })).toBeNull()
  })
})
