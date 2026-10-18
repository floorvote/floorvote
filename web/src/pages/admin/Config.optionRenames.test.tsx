import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, within, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'
import userEvent from '@testing-library/user-event'

// Mock heavy dependencies before importing Config

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

// Stub heavy components that aren't under test
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
vi.mock('../../components/BillBadge', () => ({
  BillBadge: () => null,
}))
vi.mock('../admin/aiConfig', async () => {
  const actual = await vi.importActual<typeof import('./aiConfig')>('../admin/aiConfig')
  return {
    // Real parser: still used off the paste path (parsePastedRows' sibling),
    // so tests need actual parsing behavior rather than an always-empty stub.
    parseTagTaxonomy: actual.parseTagTaxonomy,
    // Real comparison: the seed control's whole contract is that seeding a
    // blank field does NOT read as a change. A stubbed constant would make
    // every test of that behavior pass without exercising it.
    aiInstructionsChanged: actual.aiInstructionsChanged,
    configChanged: (a: Record<string, unknown>, b: Record<string, unknown>) =>
      Object.keys(a).some((k) => a[k] !== b[k]),
  }
})
vi.mock('../../lib/exportData', () => ({
  exportAllData: vi.fn(),
}))


import { apiFetch } from '../../lib/api'
const mockFetch = vi.mocked(apiFetch)

import { Config } from './Config'

const BASE_CONFIG = {
  keywords: [],
  association_name: 'Test Org',
  ai_context: '',
  relevance_question: '',
  tag_taxonomy: [] as { name: string; description?: string }[],
  matched_bills_count: 0,
  prioritized_bills_count: 0,
}

const FIELD = { id: 'f1', name: 'Stage', slug: 'stage', type: 'dropdown', options: ['Early', 'Mid', 'Late'], multiple: false, pinned: false }

beforeEach(() => {
  vi.resetAllMocks()
  demo.demoLocked = false
  mockFetch.mockImplementation(async (path: string) => {
    if (path === '/admin/config') return { ...BASE_CONFIG }
    if (path === '/admin/custom-fields') return [{ ...FIELD }]
    if (path === '/bills/drafts') return { drafts: [] }
    if (path === '/admin/custom-fields/f1') return { ok: true, slug: 'stage' }
    throw new Error('unexpected path: ' + path)
  })
})

async function openEditor() {
  render(<Config />)
  await screen.findByText('Stage')
  const pencil = screen.getAllByText('edit').map(e => e.closest('button')!).find(b => b.closest('div')?.textContent?.includes('Stage'))!
  fireEvent.click(pencil)
  await screen.findByLabelText('Option 1')
}

async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(putCalls()).toHaveLength(1))
  return JSON.parse(String(putCalls()[0][1]!.body)) as { options: string[]; renames?: { from: string; to: string }[] }
}

function putCalls() {
  return mockFetch.mock.calls.filter(c => c[0] === '/admin/custom-fields/f1' && c[1]?.method === 'PUT')
}

const type = (label: string, text: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: text } })

describe('Config: the dropdown options editor sends renames', () => {
  it('shows one row per option', async () => {
    await openEditor()
    expect(['Option 1', 'Option 2', 'Option 3'].map(l => (screen.getByLabelText(l) as HTMLInputElement).value)).toEqual(['Early', 'Mid', 'Late'])
  })

  it('sends a rename for an edited row', async () => {
    await openEditor()
    type('Option 1', 'Beginning')
    const body = await save()
    expect(body.options).toEqual(['Beginning', 'Mid', 'Late'])
    expect(body.renames).toEqual([{ from: 'Early', to: 'Beginning' }])
  })

  it('sends no renames for an added option', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Add option' }))
    type('Option 4', 'Withdrawn')
    const body = await save()
    expect(body.options).toEqual(['Early', 'Mid', 'Late', 'Withdrawn'])
    expect(body.renames ?? []).toEqual([])
  })

  it('sends no renames for a deleted option', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Remove option 2' }))
    const body = await save()
    expect(body.options).toEqual(['Early', 'Late'])
    expect(body.renames ?? []).toEqual([])
  })

  it('sends a rename only for the edited row when another is added and another deleted', async () => {
    await openEditor()
    type('Option 1', 'Beginning')
    fireEvent.click(screen.getByRole('button', { name: 'Remove option 3' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add option' }))
    type('Option 3', 'Withdrawn')
    const body = await save()
    expect(body.options).toEqual(['Beginning', 'Mid', 'Withdrawn'])
    expect(body.renames).toEqual([{ from: 'Early', to: 'Beginning' }])
  })

  it('sends no renames for a row edited and then put back', async () => {
    await openEditor()
    type('Option 1', 'Beginning')
    type('Option 1', 'Early')
    const body = await save()
    expect(body.renames ?? []).toEqual([])
  })

  it('sends both renames when two rows swap their text', async () => {
    await openEditor()
    type('Option 1', 'Mid')
    type('Option 2', 'Early')
    const body = await save()
    expect(body.options).toEqual(['Mid', 'Early', 'Late'])
    expect(body.renames).toEqual([{ from: 'Early', to: 'Mid' }, { from: 'Mid', to: 'Early' }])
  })

  it('trims an edited row and drops a row left empty without renaming it', async () => {
    await openEditor()
    type('Option 1', '  Beginning  ')
    type('Option 2', '   ')
    const body = await save()
    expect(body.options).toEqual(['Beginning', 'Late'])
    expect(body.renames).toEqual([{ from: 'Early', to: 'Beginning' }])
  })
})
