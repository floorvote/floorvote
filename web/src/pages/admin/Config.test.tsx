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

import { buildDefaultAiContext, buildDefaultRelevanceQuestion } from '../../../../shared/aiDefaults'
import { DEFAULT_TAXONOMY, serializeTaxonomy } from '../../../../shared/taxonomy'
import { aiInstructionsChanged as actualAiInstructionsChanged } from './aiConfig'

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
  tag_taxonomy: [] as { name: string; description?: string }[],
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

/**
 * Every row currently on screen in the tag table, including the trailing blank
 * the table always keeps at the end.
 */
function readTagRows(): { name: string; description: string }[] {
  const names = screen.getAllByLabelText(/^Tag name, row /) as HTMLInputElement[]
  const descriptions = screen.getAllByLabelText(/^Description, row /) as HTMLTextAreaElement[]
  return names.map((n, i) => ({ name: n.value, description: descriptions[i].value }))
}

/** The body of the last PUT to a path, parsed. */
function lastPutBody(path: string) {
  const call = [...mockFetch.mock.calls].reverse()
    .find(([p, init]) => p === path && (init as RequestInit | undefined)?.method === 'PUT')
  if (!call) throw new Error(`no PUT to ${path}`)
  return JSON.parse((call[1] as RequestInit).body as string)
}

// Override just the fields a test cares about on top of BASE_CONFIG.
function mockConfig(overrides: Partial<typeof BASE_CONFIG>) {
  mockFetch.mockImplementation(async (path: string) => {
    if (path === '/admin/config') return { ...BASE_CONFIG, ...overrides }
    if (path === '/admin/custom-fields') return []
    if (path === '/bills/drafts') return { drafts: [] }
    throw new Error('unexpected path: ' + path)
  })
}

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
    // Only ai_context has a value here (relevance_question and tag_taxonomy
    // are blank, so those two show the "Start from default" seed instead),
    // so exactly one field shows "Reset to default" — the Bill summary
    // field. The Tags field never shows this label at all now (it says
    // "Clear all"), so this count no longer includes it the way it once did.
    expect(screen.getAllByText('Reset to default').length).toBe(1)
    expect(screen.queryByText('Clear all')).not.toBeInTheDocument()
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

describe('Config — tag taxonomy formatting', () => {
  // Same behaviour as the old blank-line-separated textarea assertion: a
  // stored tag reaches the editor with its description attached to it, and a
  // tag without one reaches it with an empty description.
  it('renders each saved tag, with its description, in its own row', async () => {
    mockConfig({
      tag_taxonomy: [
        { name: 'Elections', description: 'voting and registration' },
        { name: 'Government Records' },
      ],
    })
    renderInRegistry(<Config />)
    expect(await screen.findByLabelText('Tag name, row 1')).toHaveValue('Elections')
    expect(screen.getByLabelText('Description, row 1')).toHaveValue('voting and registration')
    expect(screen.getByLabelText('Tag name, row 2')).toHaveValue('Government Records')
    expect(screen.getByLabelText('Description, row 2')).toHaveValue('')
  })

  it('does not read as an unsaved change immediately after load', async () => {
    mockConfig({
      tag_taxonomy: [
        { name: 'Elections', description: 'voting and registration' },
        { name: 'Government Records' },
      ],
    })
    const reg = renderInRegistry(<Config />)
    await screen.findByLabelText('Tag name, row 1')
    await waitFor(() => expect(reg.hasUnsaved()).toBe(false))
  })

  // Same behaviour as the deleted chip row: how many tags there are, and which
  // ones — the names now live in input values rather than in chip text.
  it('shows how many tags the editor holds, and which', async () => {
    mockConfig({
      tag_taxonomy: [
        { name: 'Elections', description: 'voting and registration' },
        { name: 'Government Records' },
      ],
    })
    renderInRegistry(<Config />)
    expect(await screen.findByTestId('tag-count')).toHaveTextContent('2')
    expect(screen.getByLabelText('Tag name, row 1')).toHaveValue('Elections')
    expect(screen.getByLabelText('Tag name, row 2')).toHaveValue('Government Records')
  })

  it('counts a single tag as one', async () => {
    mockConfig({ tag_taxonomy: [{ name: 'Elections' }] })
    renderInRegistry(<Config />)
    expect(await screen.findByTestId('tag-count')).toHaveTextContent('1')
  })

  // Untrimmed stored data (reachable via a direct API write, a restored
  // export, or hand-set config — never through this UI) must not make the
  // snapshot disagree with the derived projection it is compared against.
  it('does not read as an unsaved change immediately after load, given untrimmed stored data', async () => {
    mockConfig({
      tag_taxonomy: [{ name: 'Elections ' }, { name: 'X', description: '   ' }],
    })
    const reg = renderInRegistry(<Config />)
    await screen.findByLabelText('Tag name, row 1')
    await waitFor(() => expect(reg.hasUnsaved()).toBe(false))
  })
})

describe('Config — AI textarea typography', () => {
  it('gives the two AI instruction editors one typographic treatment', async () => {
    mockConfig({})
    renderInRegistry(<Config />)
    // Tags is a table now, not a textarea, so it is no longer part of this set;
    // the two remaining prose editors must still match each other.
    const boxes = [
      await screen.findByLabelText('Bill summary'),
      await screen.findByLabelText('Relevance score'),
    ] as HTMLTextAreaElement[]
    for (const box of boxes) {
      expect(box.style.fontSize).toBe('12px')
      expect(box.style.lineHeight).toBe('1.5')
      expect(box.style.fontFamily).toBe('')
    }
  })
})

describe('Config — reprocess-scope modal on saving AI instructions', () => {
  // Both cases need matched_bills_count > 0 — the modal only ever shows when
  // aiInstructionsChanged() is true AND there are matched bills to reprocess.
  // With zero matched bills the decision short-circuits before the comparison
  // even runs, which would make either case pass vacuously.

  it('does NOT open the reprocess modal when the typed text is just the resolved default', async () => {
    mockConfig({ matched_bills_count: 5 })
    render(<Config />)

    const textarea = (await screen.findByLabelText('Bill summary')) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: buildDefaultAiContext('Test Org') } })

    fireEvent.click(await screen.findByRole('button', { name: /save ai instructions/i }))

    await screen.findByText('Saved')
    expect(screen.queryByRole('dialog', { name: 'Instructions saved' })).toBeNull()
  })

  it('DOES open the reprocess modal when the typed text genuinely differs', async () => {
    mockConfig({ matched_bills_count: 5 })
    render(<Config />)

    const textarea = (await screen.findByLabelText('Bill summary')) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Focus only on bills affecting rural broadband access.' } })

    fireEvent.click(await screen.findByRole('button', { name: /save ai instructions/i }))

    await screen.findByText('Saved')
    expect(await screen.findByRole('dialog', { name: 'Instructions saved' })).toBeInTheDocument()
    // "No, just future bill texts" is the cancel-equivalent control (never one
    // of the destructive "Yes, reprocess..." actions), per ReprocessScopeModal.
    expect(screen.getByRole('button', { name: 'No, just future bill texts' })).toBeInTheDocument()
  })
})

describe('Config — start from default', () => {
  it('offers the seed only while a field is blank', async () => {
    mockConfig({})
    renderInRegistry(<Config />)
    const box = await screen.findByLabelText('Bill summary') as HTMLTextAreaElement
    expect(box.value).toBe('')

    const seeds = screen.getAllByRole('button', { name: 'Start from default' })
    expect(seeds.length).toBe(3)
  })

  it('does not offer the seed once the field has a value', async () => {
    mockConfig({ ai_context: 'custom instructions' })
    renderInRegistry(<Config />)
    await screen.findByLabelText('Bill summary')

    // Bill summary already has a value, so it shows Reset rather than the
    // seed trigger — only the other two (still-blank) fields offer to seed.
    expect(screen.getAllByRole('button', { name: 'Reset to default' }).length).toBe(1)
    expect(screen.getAllByRole('button', { name: 'Start from default' }).length).toBe(2)
  })

  it('fills the editor with the resolved default and flips to Reset', async () => {
    mockConfig({ association_name: 'Prairie Policy Alliance' })
    renderInRegistry(<Config />)
    const box = await screen.findByLabelText('Bill summary') as HTMLTextAreaElement

    fireEvent.click(screen.getAllByRole('button', { name: 'Start from default' })[0])

    expect(box.value).toBe(buildDefaultAiContext('Prairie Policy Alliance'))
    expect(box.value).toContain('Prairie Policy Alliance')
    expect(screen.getAllByRole('button', { name: 'Reset to default' }).length).toBe(1)
  })

  // Same behaviour as the old "seeds in the editor's own serialization": the
  // seed puts the canonical default list into the editor, entry for entry.
  it('seeds the taxonomy one row per default tag', async () => {
    mockConfig({})
    renderInRegistry(<Config />)
    await screen.findByLabelText('Tag name, row 1')

    fireEvent.click(screen.getAllByRole('button', { name: 'Start from default' })[2])

    expect(screen.getByTestId('tag-count')).toHaveTextContent(String(DEFAULT_TAXONOMY.length))
    // Plus the trailing blank the table always keeps at the end to type into.
    expect(readTagRows()).toEqual([
      ...DEFAULT_TAXONOMY.map(t => ({ name: t.name, description: t.description ?? '' })),
      { name: '', description: '' },
    ])
  })

  it('falls back to the placeholder name when none is configured', async () => {
    mockConfig({ association_name: '' })
    renderInRegistry(<Config />)
    const box = await screen.findByLabelText('Relevance score') as HTMLTextAreaElement

    fireEvent.click(screen.getAllByRole('button', { name: 'Start from default' })[1])

    expect(box.value).toBe(buildDefaultRelevanceQuestion(''))
  })

  it('renders the seed disabled on a demo tenant', async () => {
    demo.demoLocked = true
    mockConfig({})
    renderInRegistry(<Config />)
    await screen.findByLabelText('Bill summary')

    const seeds = screen.queryAllByRole('button', { name: 'Start from default' })
    expect(seeds.length).toBe(3)
    for (const btn of seeds) {
      expect((btn as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('shows Undo rather than the seed straight after a reset', async () => {
    mockConfig({ ai_context: 'custom instructions' })
    renderInRegistry(<Config />)
    await screen.findByLabelText('Bill summary')

    fireEvent.click(screen.getAllByRole('button', { name: 'Reset to default' })[0])

    expect(screen.getAllByRole('button', { name: 'Undo' }).length).toBe(1)
    expect(screen.queryAllByRole('button', { name: 'Start from default' }).length).toBe(2)
  })
})

describe('Config — seeded defaults round-trip', () => {
  it('reloads seeded tags identically and reports no change', async () => {
    const user = userEvent.setup()
    mockConfig({})
    renderInRegistry(<Config />)
    await screen.findByLabelText('Tag name, row 1')

    fireEvent.click(screen.getAllByRole('button', { name: 'Start from default' })[2])
    const seeded = readTagRows()

    // What the save actually sends — read from the real PUT body, not a
    // reimplementation of rowsToTaxonomy's filter/trim/map — and what the API
    // would hand back on the next load.
    await user.click(screen.getByRole('button', { name: 'Save AI instructions' }))
    const sent = lastPutBody('/admin/config').tag_taxonomy
    expect(sent).toEqual(DEFAULT_TAXONOMY)

    cleanup()
    mockConfig({ tag_taxonomy: sent })
    const reg = renderInRegistry(<Config />)
    await screen.findByLabelText('Tag name, row 1')

    expect(readTagRows()).toEqual(seeded)
    await waitFor(() => expect(reg.hasUnsaved()).toBe(false))
  })

  it('does not treat a seeded-but-unedited field as a change', () => {
    const blank = {
      aiContext: '',
      relevanceQuestion: '',
      tagTaxonomy: '',
    }
    const seeded = {
      aiContext: buildDefaultAiContext('Test Org'),
      relevanceQuestion: buildDefaultRelevanceQuestion('Test Org'),
      tagTaxonomy: serializeTaxonomy(DEFAULT_TAXONOMY),
    }
    expect(actualAiInstructionsChanged(blank, seeded, 'Test Org')).toBe(false)
  })

  it('still treats an edit to seeded text as a change', () => {
    const seeded = {
      aiContext: buildDefaultAiContext('Test Org'),
      relevanceQuestion: '',
      tagTaxonomy: '',
    }
    const edited = { ...seeded, aiContext: seeded.aiContext + '\n\nAlways mention rural impact.' }
    expect(actualAiInstructionsChanged(seeded, edited, 'Test Org')).toBe(true)
  })
})

describe('Config — tag taxonomy table', () => {
  async function saveAi(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Save AI instructions' }))
  }

  it('renders stored tags as table rows, not a textarea', async () => {
    mockConfig({ tag_taxonomy: [{ name: 'Elections', description: 'voting' }] })
    renderInRegistry(<Config />)
    expect(await screen.findByLabelText('Tag name, row 1')).toHaveValue('Elections')
    expect(screen.getByLabelText('Description, row 1')).toHaveValue('voting')
  })

  it('labels the Tags field\'s reset control "Clear all", not "Reset to default"', async () => {
    // Unlike aiContext/relevanceQuestion, whose default is a real generic
    // prompt ("Reset to default" describes what happens there), the Tags
    // field is a table: the control empties every row and what the admin
    // sees is an empty table. "Clear all" says that; "Reset to default"
    // would not. A revert of this label alone must fail this test even
    // though the other two fields keep saying "Reset to default".
    mockConfig({ tag_taxonomy: [{ name: 'Elections' }] })
    renderInRegistry(<Config />)
    await screen.findByLabelText('Tag name, row 1')
    // #config-tags-label's parent is the flex row holding the "Tags" label
    // and its reset control, side by side.
    const row = document.getElementById('config-tags-label')!.parentElement as HTMLElement
    expect(within(row).getByRole('button', { name: 'Clear all' })).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Reset to default' })).not.toBeInTheDocument()
  })

  it('shows the tag count in a pill beside the label', async () => {
    mockConfig({ tag_taxonomy: [{ name: 'Elections' }, { name: 'Housing' }] })
    renderInRegistry(<Config />)
    expect(await screen.findByTestId('tag-count')).toHaveTextContent('2')
  })

  it('does not count the trailing blank row', async () => {
    mockConfig({ tag_taxonomy: [{ name: 'Elections' }] })
    renderInRegistry(<Config />)
    expect(await screen.findByTestId('tag-count')).toHaveTextContent('1')
  })

  it('saves a taxonomy with the nameless rows dropped', async () => {
    const user = userEvent.setup()
    mockConfig({ tag_taxonomy: [{ name: 'Elections' }] })
    renderInRegistry(<Config />)
    await user.type(await screen.findByLabelText('Description, row 2'), 'orphaned')
    await saveAi(user)
    expect(lastPutBody('/admin/config').tag_taxonomy).toEqual([{ name: 'Elections' }])
  })

  it('saves null when every row is blank', async () => {
    const user = userEvent.setup()
    mockConfig({ tag_taxonomy: [{ name: 'Elections' }] })
    renderInRegistry(<Config />)
    await user.clear(await screen.findByLabelText('Tag name, row 1'))
    await saveAi(user)
    expect(lastPutBody('/admin/config').tag_taxonomy).toBeNull()
  })

  it('does not offer a reprocess after a pure reorder', async () => {
    const user = userEvent.setup()
    mockConfig({
      tag_taxonomy: [{ name: 'Elections' }, { name: 'Housing' }],
      matched_bills_count: 12,
    })
    renderInRegistry(<Config />)
    await user.click(await screen.findByLabelText('Tag name, row 1'))
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    await saveAi(user)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  // Warn, don't block: the spec's central decision about tag problems. A
  // duplicate cannot corrupt the prompt (the taxonomy reaches the model as an
  // enum), so a warning must never stand between an admin and their save.
  it('leaves Save enabled while a duplicate-tag warning is showing', async () => {
    mockConfig({ tag_taxonomy: [{ name: 'Elections' }, { name: 'elections' }] })
    renderInRegistry(<Config />)
    await screen.findByLabelText('Tag name, row 1')
    expect(screen.getAllByText('Duplicate')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Save AI instructions' })).not.toBeDisabled()
  })

  // The mirror image of "a pure reorder offers no reprocess": storage keeps
  // editor order, so a reorder IS an unsaved change and must not be silently
  // discarded by a navigation away. Only aiInstructionsChanged ignores order.
  it('marks the page dirty after a pure reorder', async () => {
    const user = userEvent.setup()
    mockConfig({ tag_taxonomy: [{ name: 'Elections' }, { name: 'Housing' }] })
    const reg = renderInRegistry(<Config />)
    await screen.findByLabelText('Tag name, row 1')
    await waitFor(() => expect(reg.hasUnsaved()).toBe(false))

    await user.click(screen.getByLabelText('Tag name, row 1'))
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')

    expect(screen.getByLabelText('Tag name, row 1')).toHaveValue('Housing')
    expect(reg.hasUnsaved()).toBe(true)
  })

  // The seed control shows whenever no row has a name — including when a row
  // holds a typed description the table is flagging "Needs a name". Seeding
  // overwrites every row, so it has to be undoable.
  it('Undo restores a typed orphan description destroyed by the seed', async () => {
    const user = userEvent.setup()
    mockConfig({})
    renderInRegistry(<Config />)
    await user.type(await screen.findByLabelText('Description, row 1'), 'municipal broadband')
    expect(screen.getByText('Needs a name')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Start from default' })[2])
    expect(screen.getByTestId('tag-count')).toHaveTextContent(String(DEFAULT_TAXONOMY.length))

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByLabelText('Description, row 1')).toHaveValue('municipal broadband')
  })

  it('still offers a reprocess when a description actually changes', async () => {
    const user = userEvent.setup()
    mockConfig({
      tag_taxonomy: [{ name: 'Elections', description: 'voting' }],
      matched_bills_count: 12,
    })
    renderInRegistry(<Config />)
    await user.type(await screen.findByLabelText('Description, row 1'), ' and canvassing')
    await saveAi(user)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })
})

describe('Config — tag taxonomy header sort', () => {
  function sortButton() {
    // Accessible name now leads with the visible "Tag" text — see
    // TagTaxonomyTable's Label-in-Name fix.
    return screen.getByRole('button', { name: /^Tag,/i })
  }

  async function saveAi(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Save AI instructions' }))
  }

  // This proves the wiring — that a sort reaches configChanged's dirty
  // check at all — not the comparator's order-sensitivity itself. That's
  // pinned separately, and more directly, by the "configChanged — taxonomy
  // order" block in aiConfig.test.ts; do not mistake this test for proof of
  // the comparator.
  it('marks the page dirty', async () => {
    const user = userEvent.setup()
    mockConfig({ tag_taxonomy: [{ name: 'Zoning' }, { name: 'Elections' }] })
    const reg = renderInRegistry(<Config />)
    await screen.findByLabelText('Tag name, row 1')
    await waitFor(() => expect(reg.hasUnsaved()).toBe(false))

    await user.click(sortButton())

    expect(screen.getByLabelText('Tag name, row 1')).toHaveValue('Elections')
    expect(reg.hasUnsaved()).toBe(true)
  })

  it('does not open the reprocess dialog on save — the payoff of the order-insensitive comparison', async () => {
    const user = userEvent.setup()
    mockConfig({
      tag_taxonomy: [{ name: 'Zoning' }, { name: 'Elections' }],
      matched_bills_count: 12,
    })
    renderInRegistry(<Config />)
    await screen.findByLabelText('Tag name, row 1')

    await user.click(sortButton())
    await saveAi(user)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('offers Undo after sorting, and clicking it restores the pre-sort order', async () => {
    const user = userEvent.setup()
    mockConfig({ tag_taxonomy: [{ name: 'Zoning' }, { name: 'Elections' }] })
    renderInRegistry(<Config />)
    await screen.findByLabelText('Tag name, row 1')

    await user.click(sortButton())
    expect(screen.getByLabelText('Tag name, row 1')).toHaveValue('Elections')

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByLabelText('Tag name, row 1')).toHaveValue('Zoning')
  })

  // A second header click has no gate on it the way "Start from default" and
  // "Reset to default" do (renderResetControl swaps them for Undo once a
  // value is captured, so those two can never fire twice in a row) — the
  // sort button stays on screen and clickable after it fires. Capturing the
  // undo value unconditionally on every sort would let a second click
  // overwrite the hand-curated original order with the already-sorted one.
  it('two consecutive header clicks then Undo restores the ORIGINAL order, not the first sort', async () => {
    const user = userEvent.setup()
    mockConfig({ tag_taxonomy: [{ name: 'Mango' }, { name: 'Apple' }, { name: 'Zebra' }] })
    renderInRegistry(<Config />)
    await screen.findByLabelText('Tag name, row 1')

    await user.click(sortButton()) // -> Apple, Mango, Zebra (ascending)
    expect(screen.getByLabelText('Tag name, row 1')).toHaveValue('Apple')
    await user.click(sortButton()) // -> Zebra, Mango, Apple (descending)
    expect(screen.getByLabelText('Tag name, row 1')).toHaveValue('Zebra')

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    // Must be the hand-curated original, not the first (ascending) sort.
    expect(screen.getByLabelText('Tag name, row 1')).toHaveValue('Mango')
    expect(screen.getByLabelText('Tag name, row 2')).toHaveValue('Apple')
    expect(screen.getByLabelText('Tag name, row 3')).toHaveValue('Zebra')
  })

  // The same unconditional-capture bug also destroys a "Start from default"
  // undo value — including a half-typed orphan description — the moment a
  // sort runs afterward, since both write into the same undoValues.tagTaxonomy
  // slot.
  it('"Start from default" then a header click then Undo restores what the seed replaced', async () => {
    const user = userEvent.setup()
    mockConfig({})
    renderInRegistry(<Config />)
    await user.type(await screen.findByLabelText('Description, row 1'), 'municipal broadband')
    expect(screen.getByText('Needs a name')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Start from default' })[2])
    expect(screen.getByTestId('tag-count')).toHaveTextContent(String(DEFAULT_TAXONOMY.length))

    await user.click(sortButton())

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByLabelText('Description, row 1')).toHaveValue('municipal broadband')
  })
})

// The same outcome matrix the tag table and saved views carry, asserting the
// resulting ORDER rather than counting indicator elements. Counting is what let
// two bugs survive here for as long as they did: the line renders in the right
// place, and only the result is wrong.
describe('Config — custom fields drag-to-reorder', () => {
  const FIELDS = [
    { id: 'a', name: 'Alpha', type: 'text', pinned: false },
    { id: 'b', name: 'Bravo', type: 'text', pinned: false },
    { id: 'c', name: 'Charlie', type: 'text', pinned: false },
  ]

  function mockFields() {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/config') return { ...BASE_CONFIG }
      if (path === '/admin/custom-fields') return FIELDS.map(f => ({ ...f }))
      if (path === '/admin/custom-fields/reorder') return {}
      if (path === '/bills/drafts') return { drafts: [] }
      throw new Error('unexpected path: ' + path)
    })
  }

  async function setup() {
    mockFields()
    render(<Config />)
    await screen.findByText('Alpha')
  }

  /** The field row: the flex div holding the grip, the name and the controls. */
  const row = (name: string) => screen.getByText(name).closest('div') as HTMLElement
  /** The grip is the only ⠿ inside a row. */
  const grip = (name: string) => within(row(name)).getByText('⠿')
  /** The append-at-end drop zone: the last child of the bordered list container. */
  const tail = () => row('Alpha').parentElement!.parentElement!.lastElementChild as HTMLElement

  /** Field names in DOM order. */
  function order() {
    return ['Alpha', 'Bravo', 'Charlie']
      .map(n => ({ n, el: screen.getByText(n) }))
      .sort((x, y) => (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map(x => x.n)
  }

  function reorderCalls() {
    return mockFetch.mock.calls.filter(c => c[0] === '/admin/custom-fields/reorder')
  }

  function fakeDataTransfer() {
    let stored = ''
    return {
      effectAllowed: '',
      dropEffect: '',
      setData: (_type: string, value: string) => { stored = value },
      getData: () => stored,
    }
  }

  // One act() per event, not one around the batch: the primitive's handlers
  // bail out when no reorder is in progress (so an ordinary drag falls through
  // to the browser), and batching dragstart with the dragover that follows it
  // would leave the row still rendering with dragFrom === null. A real browser
  // delivers these as separate tasks.
  async function drag(from: string, to: string | 'tail') {
    const dataTransfer = fakeDataTransfer()
    const target = to === 'tail' ? tail() : row(to)
    await act(async () => { fireEvent.dragStart(grip(from), { dataTransfer }) })
    await act(async () => { fireEvent.dragOver(target, { dataTransfer }) })
    await act(async () => { fireEvent.drop(target, { dataTransfer }) })
    await act(async () => { fireEvent.dragEnd(target, { dataTransfer }) })
  }

  it('drag Alpha, drop on Charlie inserts Alpha immediately before Charlie', async () => {
    await setup()
    await drag('Alpha', 'Charlie')
    expect(order()).toEqual(['Bravo', 'Alpha', 'Charlie'])
    expect(JSON.parse(String(reorderCalls()[0][1]!.body)).order).toEqual(['b', 'a', 'c'])
  })

  it('drag Charlie, drop on Alpha inserts Charlie immediately before Alpha', async () => {
    await setup()
    await drag('Charlie', 'Alpha')
    expect(order()).toEqual(['Charlie', 'Alpha', 'Bravo'])
    expect(JSON.parse(String(reorderCalls()[0][1]!.body)).order).toEqual(['c', 'a', 'b'])
  })

  it('drag Alpha, drop on the tail zone moves Alpha to the end', async () => {
    await setup()
    await drag('Alpha', 'tail')
    expect(order()).toEqual(['Bravo', 'Charlie', 'Alpha'])
    expect(JSON.parse(String(reorderCalls()[0][1]!.body)).order).toEqual(['b', 'c', 'a'])
  })

  it('drag Alpha, drop on Bravo changes nothing and persists nothing', async () => {
    await setup()
    await drag('Alpha', 'Bravo')
    expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(reorderCalls()).toHaveLength(0)
  })

  it('drag Charlie, drop on the tail zone changes nothing and persists nothing', async () => {
    await setup()
    await drag('Charlie', 'tail')
    expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(reorderCalls()).toHaveLength(0)
  })

  it('puts draggable on the grip, not on the whole row', async () => {
    await setup()
    // A whole-row draggable makes the browser's drag image the entire row —
    // the "whole row moving" feel the other two lists never had — and makes the
    // rendered grip purely decorative.
    expect(grip('Alpha')).toHaveAttribute('draggable', 'true')
    expect(row('Alpha')).not.toHaveAttribute('draggable', 'true')
  })

  it('dims the source row from state, without mutating style.opacity on the node', async () => {
    await setup()
    const dataTransfer = fakeDataTransfer()
    await act(async () => { fireEvent.dragStart(grip('Bravo'), { dataTransfer }) })
    expect(row('Bravo')).toHaveStyle({ opacity: '0.4' })
    expect(row('Alpha')).toHaveStyle({ opacity: '1' })
    await act(async () => { fireEvent.dragEnd(grip('Bravo'), { dataTransfer }) })
    expect(row('Bravo')).toHaveStyle({ opacity: '1' })
  })

  it('offers no grip while a row is being edited', async () => {
    await setup()
    await act(async () => { fireEvent.click(within(row('Bravo')).getByText('edit').closest('button')!) })
    const editInput = screen.getByDisplayValue('Bravo')
    expect(editInput).toBeInTheDocument()
    // Once editing starts, "Bravo" is an input value rather than text, so the
    // edited row has to be reached via the input rather than by name.
    const editingRow = editInput.closest('div')!.parentElement as HTMLElement
    expect(within(editingRow).queryByText('⠿')).not.toBeInTheDocument()
    // The other rows keep theirs.
    expect(grip('Alpha')).toHaveAttribute('draggable', 'true')
  })

  it('offers no drag at all on a demo-locked tenant', async () => {
    demo.demoLocked = true
    await setup()
    expect(grip('Alpha')).not.toHaveAttribute('draggable', 'true')
    await drag('Alpha', 'Charlie')
    expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(reorderCalls()).toHaveLength(0)
  })
})
