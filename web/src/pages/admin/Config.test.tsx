import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, within, fireEvent } from '@testing-library/react'
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
  configChanged: (a: Record<string, unknown>, b: Record<string, unknown>) =>
    Object.keys(a).some((k) => a[k] !== b[k]),
}))
vi.mock('../../lib/exportData', () => ({
  exportAllData: vi.fn(),
}))

import { apiFetch } from '../../lib/api'
const mockFetch = vi.mocked(apiFetch)

import { Config } from './Config'
import { createUnsavedRegistry, UnsavedTextContext } from '../../lib/unsavedText'

function renderInRegistry(ui: React.ReactElement) {
  const reg = createUnsavedRegistry()
  render(<UnsavedTextContext.Provider value={reg}>{ui}</UnsavedTextContext.Provider>)
  return reg
}

const BASE_CONFIG = {
  keywords: [],
  association_name: 'Test Org',
  ai_context: '',
  relevance_question: '',
  tag_taxonomy: [],
  matched_bills_count: 0,
  prioritized_bills_count: 0,
}

beforeEach(() => {
  vi.resetAllMocks()
  demo.demoLocked = false
  mockFetch.mockImplementation(async (path: string) => {
    if (path === '/admin/config') return { ...BASE_CONFIG }
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
      // /admin/config hangs — simulates in-flight
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

  it('in demo: disables "Save AI instructions" (covers the Tags/tag-taxonomy editor)', async () => {
    demo.demoLocked = true
    render(<Config />)
    expect(await screen.findByRole('button', { name: /save ai instructions/i })).toBeDisabled()
  })

  it('when not in demo: leaves "Save AI instructions" enabled', async () => {
    render(<Config />)
    expect(await screen.findByRole('button', { name: /save ai instructions/i })).toBeEnabled()
  })

  // A disabled button fires no pointer events, so hover handlers placed on the
  // button itself go dead in exactly the situation where the explanation is most
  // useful: a demo visitor who cannot click the control and wants to know what it
  // would do. The handlers therefore live on a wrapper element.
  it('in demo: the custom-field pin tooltip still appears on hover, though the button is disabled', async () => {
    demo.demoLocked = true
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/config') return { ...BASE_CONFIG }
      if (path === '/admin/custom-fields') return [{ id: 'cf1', name: 'Coalition lead', type: 'text', pinned: false }]
      if (path === '/bills/drafts') return { drafts: [] }
      throw new Error('unexpected path: ' + path)
    })
    render(<Config />)

    const pinButton = await screen.findByText('keep')
    const button = pinButton.closest('button')!
    expect(button).toBeDisabled()

    // The wrapper carries the hover, not the dead button.
    const hoverTarget = button.parentElement!
    await act(async () => { fireEvent.mouseEnter(hoverTarget) })

    expect(await screen.findByText(/Pinned fields, when they are filled out, appear above the AI summary/i))
      .toBeInTheDocument()
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

describe('Config — preset panel removed', () => {
  it('renders no preset panel and does not fetch /admin/presets', async () => {
    const paths: string[] = []
    mockFetch.mockImplementation(async (path: string) => {
      paths.push(path)
      if (path === '/admin/config') return { ...BASE_CONFIG, ai_context: undefined }
      if (path === '/admin/custom-fields') return []
      return {}
    })

    render(<Config />)
    await screen.findByText('Bill keywords')

    expect(paths).not.toContain('/admin/presets')
    expect(screen.queryByText(/Load a preset/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  })

  it('shows the personalization hint when ai_context is blank and hides it once set', async () => {
    // Isolate the ai_context field: give relevance_question and tag_taxonomy real
    // values so only the Bill summary field's hint renders, not all three.
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/config') return {
        ...BASE_CONFIG,
        ai_context: '',
        relevance_question: 'Custom relevance question.',
        tag_taxonomy: [{ name: 'Custom Tag' }],
      }
      if (path === '/admin/custom-fields') return []
      return {}
    })

    render(<Config />)
    expect(await screen.findByText(/Leaving this blank uses the generic instructions/)).toBeTruthy()
  })

  it('hides the personalization hint once ai_context is set', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/config') return {
        ...BASE_CONFIG,
        ai_context: 'Custom voice.',
        relevance_question: 'Custom relevance question.',
        tag_taxonomy: [{ name: 'Custom Tag' }],
      }
      if (path === '/admin/custom-fields') return []
      return {}
    })

    render(<Config />)
    await screen.findByText('AI instructions')
    expect(screen.queryByText(/Leaving this blank uses the generic instructions/)).toBeNull()
  })

  it('offers "Reset to default" rather than "Reset to preset"', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/config') return { ...BASE_CONFIG, ai_context: 'Custom voice.' }
      if (path === '/admin/custom-fields') return []
      return {}
    })

    render(<Config />)
    await screen.findByText('AI instructions')
    expect(screen.queryByText('Reset to preset')).toBeNull()
    expect(screen.getAllByText('Reset to default').length).toBeGreaterThan(0)
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

describe('Config — reset/clear undo', () => {
  it('Undo restores a field cleared with "Reset to default"', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/config') return { ...BASE_CONFIG, ai_context: 'Custom AI voice.' }
      if (path === '/admin/custom-fields') return []
      return {}
    })
    render(<Config />)

    const label = await screen.findByText('Bill summary')
    const row = label.parentElement as HTMLElement
    const textarea = (await screen.findByLabelText('Bill summary')) as HTMLTextAreaElement
    expect(textarea.value).toBe('Custom AI voice.')

    fireEvent.click(within(row).getByRole('button', { name: 'Reset to default' }))
    expect(textarea.value).toBe('')
    expect(within(row).getByRole('button', { name: 'Undo' })).toBeInTheDocument()

    fireEvent.click(within(row).getByRole('button', { name: 'Undo' }))
    expect(textarea.value).toBe('Custom AI voice.')
    expect(within(row).queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(within(row).getByRole('button', { name: 'Reset to default' })).toBeInTheDocument()
  })

  it('a manual edit after Reset clears the Undo affordance', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/config') return { ...BASE_CONFIG, ai_context: 'Custom AI voice.' }
      if (path === '/admin/custom-fields') return []
      return {}
    })
    render(<Config />)

    const label = await screen.findByText('Bill summary')
    const row = label.parentElement as HTMLElement
    const textarea = (await screen.findByLabelText('Bill summary')) as HTMLTextAreaElement

    fireEvent.click(within(row).getByRole('button', { name: 'Reset to default' }))
    expect(within(row).getByRole('button', { name: 'Undo' })).toBeInTheDocument()

    fireEvent.change(textarea, { target: { value: 'Something the admin typed instead.' } })

    expect(within(row).queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(within(row).getByRole('button', { name: 'Reset to default' })).toBeInTheDocument()
  })
})

describe('Config — empty keyword list confirm copy', () => {
  it('skips the preview call and warns that future bills stop being captured', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const paths: string[] = []
    mockFetch.mockImplementation(async (path: string) => {
      paths.push(path)
      if (path === '/admin/config') return { ...BASE_CONFIG }
      if (path === '/admin/custom-fields') return []
      return {}
    })

    render(<Config />)
    const saveBtn = await screen.findByRole('button', { name: /save keywords and sync/i })
    fireEvent.click(saveBtn)

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(paths).not.toContain('/admin/keyword-resync-preview')
    const confirmMsg = confirmSpy.mock.calls[0][0] as string
    expect(confirmMsg).toMatch(/no new bills will be captured for full analysis/i)
    expect(confirmMsg).toMatch(/keep their summaries/i)
    expect(confirmMsg).not.toMatch(/no bills will be added or downgraded/i)

    confirmSpy.mockRestore()
  })

  it('still shows real counts (not the empty-list copy) when removing some but not all keywords', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/config') return { ...BASE_CONFIG, keywords: ['zoning', 'housing'] }
      if (path === '/admin/custom-fields') return []
      if (path === '/admin/keyword-resync-preview') return { wouldAdd: 0, wouldDemote: 2, wouldProtect: 0 }
      return {}
    })

    render(<Config />)
    const textarea = (await screen.findByLabelText('Keywords')) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'zoning' } })

    const saveBtn = await screen.findByRole('button', { name: /save keywords and sync/i })
    fireEvent.click(saveBtn)

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    const confirmMsg = confirmSpy.mock.calls[0][0] as string
    expect(confirmMsg).toMatch(/2 bills will be downgraded/i)

    confirmSpy.mockRestore()
  })
})

describe('Config — org-noun-aware tag hint', () => {
  it('uses the default org noun ("team") in the tag personalization hint', async () => {
    render(<Config />)
    expect(await screen.findByText(/keeps tags meaningful to your team's own priorities/i)).toBeInTheDocument()
  })

  it('uses a custom org noun in the tag personalization hint', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/config') return { ...BASE_CONFIG, org_noun: 'league' }
      if (path === '/admin/custom-fields') return []
      return {}
    })
    render(<Config />)
    expect(await screen.findByText(/keeps tags meaningful to your league's own priorities/i)).toBeInTheDocument()
  })
})

describe('Config — unsaved-changes guard', () => {
  it('is clean after load, dirty after an edit, and clean again after a successful save', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/config') return { ...BASE_CONFIG }
      if (path === '/admin/custom-fields') return []
      return {}
    })

    const reg = renderInRegistry(<Config />)
    const input = (await screen.findByLabelText('Group name')) as HTMLInputElement
    await waitFor(() => expect(reg.hasUnsaved()).toBe(false))

    fireEvent.change(input, { target: { value: 'New Org Name' } })
    expect(reg.hasUnsaved()).toBe(true)

    const labelsHeading = screen.getByRole('heading', { name: 'Labels' })
    const labelsSection = labelsHeading.parentElement as HTMLElement
    const saveBtn = within(labelsSection).getByRole('button', { name: /^save$/i })
    fireEvent.click(saveBtn)

    await waitFor(() => expect(reg.hasUnsaved()).toBe(false))
  })

  it('reset() restores the field to its last-saved value', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/config') return { ...BASE_CONFIG, association_name: 'Original Org' }
      if (path === '/admin/custom-fields') return []
      return {}
    })

    const reg = renderInRegistry(<Config />)
    const input = (await screen.findByLabelText('Group name')) as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('Original Org'))

    fireEvent.change(input, { target: { value: 'Edited but not saved' } })
    expect(reg.hasUnsaved()).toBe(true)

    act(() => reg.resetAll())

    expect(input.value).toBe('Original Org')
    expect(reg.hasUnsaved()).toBe(false)
  })
})
