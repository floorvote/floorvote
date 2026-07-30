import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, within } from '@testing-library/react'
import React from 'react'

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
vi.mock('../../components/ReprocessScopeModal', () => ({
  ReprocessScopeModal: () => null,
}))
vi.mock('../../components/BillBadge', () => ({
  BillBadge: () => null,
}))
vi.mock('../admin/aiConfig', () => ({
  parseTagTaxonomy: (_v: string) => ({ ok: true, value: [], error: null }),
  aiInstructionsChanged: () => false,
}))
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
  tag_taxonomy: [],
  instance_preset: null,
  matched_bills_count: 0,
  prioritized_bills_count: 0,
}

const EMPTY_PRESETS: never[] = []

beforeEach(() => {
  vi.resetAllMocks()
  demo.demoLocked = false
  mockFetch.mockImplementation(async (path: string) => {
    if (path === '/admin/config') return { ...BASE_CONFIG }
    if (path === '/admin/presets') return EMPTY_PRESETS
    if (path === '/admin/custom-fields') return []
    if (path === '/bills/drafts') return { drafts: [] }
    throw new Error('unexpected path: ' + path)
  })
})

// Helper: find the noun <select> by its unique option "Custom…"
function getNounSelect(): HTMLSelectElement {
  // The noun select has a unique option value "custom" with text "Custom…"
  const options = screen.getAllByRole('option', { name: 'Custom…' })
  return options[0].closest('select') as HTMLSelectElement
}

describe('Config — per-section loading skeleton', () => {
  it('shows section title "Bill keywords" immediately while fetch is in flight', () => {
    // Use a promise that never resolves so we can assert the pre-load DOM
    let _resolve: (v: unknown) => void
    const neverSettles = new Promise(r => { _resolve = r })
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/custom-fields') return []
      if (path === '/bills/drafts') return { drafts: [] }
      // /admin/config and /admin/presets hang — simulates in-flight
      return neverSettles as never
    })

    render(<Config />)

    // Section title must be in the DOM synchronously (before any microtasks flush)
    expect(screen.getByText('Bill keywords')).toBeInTheDocument()

    // Silence React state-update-after-unmount noise by resolving before cleanup
    act(() => { _resolve({}) })
  })

  it('does NOT show the "No keywords configured" warning while loading', () => {
    let _resolve: (v: unknown) => void
    const neverSettles = new Promise(r => { _resolve = r })
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/custom-fields') return []
      if (path === '/bills/drafts') return { drafts: [] }
      return neverSettles as never
    })

    render(<Config />)

    // The warning must NOT appear before data loads (keywords state is '' during loading)
    expect(screen.queryByText(/no keywords configured/i)).toBeNull()

    act(() => { _resolve({}) })
  })

  it('DOES show the "No keywords configured" warning after load with empty keywords', async () => {
    // Base config has keywords: [] — so the warning should appear after load
    render(<Config />)

    // After data resolves, the warning is legitimate
    await waitFor(() =>
      expect(screen.getByText(/no keywords configured/i)).toBeInTheDocument()
    )
  })
})

describe('Config — org noun select', () => {
  it('shows preset value "coalition" selected and no custom input', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/config') return { ...BASE_CONFIG, org_noun: 'coalition' }
      if (path === '/admin/presets') return EMPTY_PRESETS
      if (path === '/admin/custom-fields') return []
      if (path === '/bills/drafts') return { drafts: [] }
      throw new Error('unexpected path: ' + path)
    })

    render(<Config />)

    await waitFor(() => getNounSelect())
    const select = getNounSelect()
    expect(select.value).toBe('coalition')
    // No custom text input should be visible
    expect(screen.queryByPlaceholderText(/e\.g\. league, network, caucus/i)).toBeNull()
  })

  it('shows "custom" selected and pre-fills input for non-preset noun "league"', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/config') return { ...BASE_CONFIG, org_noun: 'league' }
      if (path === '/admin/presets') return EMPTY_PRESETS
      if (path === '/admin/custom-fields') return []
      if (path === '/bills/drafts') return { drafts: [] }
      throw new Error('unexpected path: ' + path)
    })

    render(<Config />)

    await waitFor(() => getNounSelect())
    const select = getNounSelect()
    expect(select.value).toBe('custom')

    const customInput = screen.getByPlaceholderText(/e\.g\. league, network, caucus/i) as HTMLInputElement
    expect(customInput.value).toBe('league')
    // Custom noun is length-capped to guard against pasted junk
    expect(customInput.maxLength).toBe(32)
  })

  it('does not render a "Relevance label" input', async () => {
    render(<Config />)
    await waitFor(() => getNounSelect())
    // The old field must not appear
    expect(screen.queryByPlaceholderText(/topic relevance/i)).toBeNull()
    // And the noun select must exist (confirm we're looking at the right rendered state)
    expect(getNounSelect()).toBeTruthy()
  })
})

describe('Config — owner-only Clear interactions button', () => {
  it('shows the button to a non-owner Admin but disabled', async () => {
    // useAuth is mocked as an Admin (not owner) at module scope.
    render(<Config />)
    const btn = await screen.findByRole('button', { name: 'Clear all member interactions' })
    expect(btn).toBeInTheDocument()
    expect(btn).toBeDisabled()
  })
})

describe('Config — demo gating', () => {
  it('in demo: relevance slider is draggable but Save is disabled', async () => {
    demo.demoLocked = true
    render(<Config />)
    const slider = await screen.findByRole('slider')      // the relevance range input
    expect(slider).not.toBeDisabled()
    // Scope to the New-matches section card, which holds both the slider and
    // its own Save button, so this pins the specific control under test rather
    // than any Save button on the page.
    const section = slider.closest('div')!.parentElement as HTMLElement
    const saveButton = within(section).getByRole('button', { name: /^save$/i })
    expect(saveButton).toBeDisabled()
  })
})

describe('Config — data export control accessibility', () => {
  it('does not announce as disabled when export is available', async () => {
    render(<Config />)
    const exportBtn = await screen.findByRole('button', { name: /download all data/i })
    expect(exportBtn).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('announces aria-disabled="true" while an export is in flight', async () => {
    const { exportAllData } = await import('../../lib/exportData')
    let resolveExport: () => void
    vi.mocked(exportAllData).mockImplementation(() => new Promise((r) => { resolveExport = () => r(undefined) }))

    render(<Config />)
    const exportBtn = await screen.findByRole('button', { name: /download all data/i })
    act(() => { exportBtn.click() })

    await waitFor(() => expect(exportBtn).toHaveAttribute('aria-disabled', 'true'))

    act(() => { resolveExport() })
  })

  it('announces aria-disabled="true" in demo mode (demoLocked)', async () => {
    demo.demoLocked = true
    render(<Config />)
    const exportBtn = await screen.findByRole('button', { name: /download all data/i })
    expect(exportBtn).toHaveAttribute('aria-disabled', 'true')
  })
})

describe('Config heading structure', () => {
  it('exposes exactly one top-level (visually-hidden) heading naming the page', () => {
    render(<Config />)
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
    expect(h1s[0]).toHaveTextContent('Settings')
  })

  it('exposes each section title as a level-2 heading', () => {
    render(<Config />)
    for (const name of ['Bill keywords', 'AI instructions', 'New matches', 'Custom fields', 'Labels', 'Additional operations']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument()
    }
  })
})
