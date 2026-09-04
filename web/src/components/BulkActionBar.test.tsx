import { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { BulkActionBar, type Selection } from './BulkActionBar'

vi.mock('../lib/api', () => ({ apiFetch: vi.fn(() => Promise.resolve({ dismissed: 1 })) }))
import { apiFetch } from '../lib/api'

// Mutable flag so individual tests can opt into demoLocked without a
// module-level mock rewrite per test (mirrors Members.roleRename.test.tsx).
const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked }),
}))

const noFilters = {
  status: [], priority: [], position: [], year: [], state: [], tag: [], subject: [],
  q: '', minRelevance: 0, myBills: false, unvoted: false, newMatches: false, cf: {},
}

function Harness({
  selectedBills = [{ id: 'bill-1', priority: null as string | null, position: null as string | null }],
  onApplied = vi.fn(),
}: {
  selectedBills?: Array<{ id: string; priority: string | null; position: string | null; matchType?: string | null; newMatchAt?: string | null; triagedAt?: string | null }>
  onApplied?: (updatedIds: string[] | 'filter', updates: Record<string, unknown>) => void
}) {
  const [selection] = useState<Selection>({ mode: 'ids', ids: new Set(selectedBills.map(b => b.id)) })
  return (
    <BulkActionBar
      selection={selection}
      total={selectedBills.length}
      positionVocabulary={['Support', 'Oppose']}
      customFieldDefs={[]}
      currentFilters={noFilters}
      filterNewMatchCount={0}
      selectedBills={selectedBills}
      onClearSelection={vi.fn()}
      onApplied={onApplied}
    />
  )
}

const priorityPill = () => screen.getByRole('button', { name: /Priority:/i })

describe('BulkActionBar single-select pills', () => {
  it('starts with "Not set" and opens a radio list of options', () => {
    render(<Harness />)
    expect(priorityPill()).toHaveTextContent(/Priority:\s*Not set/)
    fireEvent.click(priorityPill())
    // The dropdown shows the priority options
    expect(screen.getByText('High')).toBeInTheDocument()
    expect(screen.getByText('Medium')).toBeInTheDocument()
    expect(screen.getByText('Low')).toBeInTheDocument()
  })

  it('selects a value and shows it as staged', () => {
    render(<Harness />)
    fireEvent.click(priorityPill())
    fireEvent.click(screen.getByText('High'))
    expect(priorityPill()).toHaveTextContent(/Priority:\s*High/)
    // Selecting closes the dropdown
    expect(screen.queryByText('Medium')).not.toBeInTheDocument()
  })

  it('undoes a staged change back to the initial value', () => {
    render(<Harness />)
    fireEvent.click(priorityPill())
    fireEvent.click(screen.getByText('High'))
    fireEvent.click(screen.getByTitle('Undo Priority change'))
    expect(priorityPill()).toHaveTextContent(/Priority:\s*Not set/)
    expect(screen.queryByTitle('Undo Priority change')).not.toBeInTheDocument()
  })

  it('reflects a shared initial value across the selection', () => {
    render(
      <Harness
        selectedBills={[
          { id: 'a', priority: 'high', position: null },
          { id: 'b', priority: 'high', position: null },
        ]}
      />,
    )
    expect(priorityPill()).toHaveTextContent(/Priority:\s*High/)
  })
})

describe('BulkActionBar — dismiss new matches', () => {
  const dismissBtn = () => screen.queryByRole('button', { name: /Dismiss new matches/i })

  it('is hidden when no selected bill is an un-triaged new match', () => {
    render(<Harness selectedBills={[{ id: 'a', priority: null, position: null, matchType: 'manual', newMatchAt: null }]} />)
    expect(dismissBtn()).not.toBeInTheDocument()
  })

  it('appears when a selected bill is an un-triaged new match, and dismisses on click', async () => {
    vi.mocked(apiFetch).mockClear()
    render(<Harness selectedBills={[{ id: 'a', priority: null, position: null, matchType: 'keyword', newMatchAt: '2026-06-20', triagedAt: null }]} />)
    const btn = dismissBtn()
    expect(btn).toBeInTheDocument()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(btn!)
    expect(apiFetch).toHaveBeenCalledWith('/bills/bulk-dismiss', expect.objectContaining({ method: 'POST' }))
  })

  it('stays hidden for an already-triaged keyword match', () => {
    render(<Harness selectedBills={[{ id: 'a', priority: null, position: null, matchType: 'keyword', newMatchAt: '2026-06-20', triagedAt: '2026-06-20' }]} />)
    expect(dismissBtn()).not.toBeInTheDocument()
  })

  it('calls onApplied with only the dismissed subset ids and a triagedAt stamp (ids mode)', async () => {
    vi.mocked(apiFetch).mockClear()
    const onApplied = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <Harness
        onApplied={onApplied}
        selectedBills={[
          { id: 'a', priority: null, position: null, matchType: 'keyword', newMatchAt: '2026-06-20', triagedAt: null },
          { id: 'm', priority: null, position: null, matchType: 'manual', newMatchAt: null, triagedAt: null },
        ]}
      />,
    )
    fireEvent.click(dismissBtn()!)
    await waitFor(() => expect(onApplied).toHaveBeenCalled())
    expect(onApplied).toHaveBeenCalledWith(['a'], expect.objectContaining({ triagedAt: expect.any(String) }))
  })
})

describe('BulkActionBar new-match dismiss (filter mode)', () => {
  it('shows the injected filter count and sends newMatches on dismiss', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const selection: Selection = { mode: 'filter' }
    render(
      <BulkActionBar
        selection={selection}
        total={682}
        positionVocabulary={['Support', 'Oppose']}
        customFieldDefs={[]}
        currentFilters={{ ...noFilters, newMatches: true }}
        filterNewMatchCount={682}
        selectedBills={[]}
        onClearSelection={vi.fn()}
        onApplied={vi.fn()}
      />
    )
    const dismissBtn = await screen.findByRole('button', { name: /Dismiss new matches \(682\)/i })
    fireEvent.click(dismissBtn)
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/bills/bulk-dismiss',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"newMatches":"1"'),
        }),
      )
    })
  })

  // CRITICAL 1 regression: buildFilterBody previously dropped `subject` entirely,
  // so a bulk action taken while a subject filter was active would silently
  // resolve against every bill matching the other filters — not just the ones
  // the admin saw and confirmed. The request body must carry the active subject
  // filter the same way it carries every other active filter.
  it('serializes the active subject filter into the bulk-dismiss request body', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const selection: Selection = { mode: 'filter' }
    render(
      <BulkActionBar
        selection={selection}
        total={12}
        positionVocabulary={['Support', 'Oppose']}
        customFieldDefs={[]}
        currentFilters={{ ...noFilters, newMatches: true, subject: ['UT:Election Law'] }}
        filterNewMatchCount={12}
        selectedBills={[]}
        onClearSelection={vi.fn()}
        onApplied={vi.fn()}
      />
    )
    const dismissBtn = await screen.findByRole('button', { name: /Dismiss new matches \(12\)/i })
    fireEvent.click(dismissBtn)
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/bills/bulk-dismiss',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"subject":["UT:Election Law"]'),
        }),
      )
    })
  })

  it('still dismisses when the queue exceeds the 1,000 edit cap (overLimit)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const selection: Selection = { mode: 'filter' }
    render(
      <BulkActionBar
        selection={selection}
        total={1500}
        positionVocabulary={['Support', 'Oppose']}
        customFieldDefs={[]}
        currentFilters={{ ...noFilters, newMatches: true }}
        filterNewMatchCount={1500}
        selectedBills={[]}
        onClearSelection={vi.fn()}
        onApplied={vi.fn()}
      />
    )
    const dismissBtn = await screen.findByRole('button', { name: /Dismiss new matches \(1,500\)/i })
    fireEvent.click(dismissBtn)
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/bills/bulk-dismiss', expect.objectContaining({ method: 'POST' }))
    })
  })
})

describe('BulkActionBar read-only demo', () => {
  afterEach(() => { demoState.demoLocked = false })

  it('disables Apply even with a staged change, and does not POST on click', () => {
    demoState.demoLocked = true
    render(<Harness />)
    fireEvent.click(priorityPill())
    fireEvent.click(screen.getByText('High'))
    const applyBtn = screen.getByRole('button', { name: /Apply to 1 bill/i })
    expect(applyBtn).toBeDisabled()
    fireEvent.click(applyBtn)
    expect(apiFetch).not.toHaveBeenCalledWith('/bills/bulk', expect.anything())
  })

  it('disables "Dismiss new matches" and does not POST on click', () => {
    demoState.demoLocked = true
    vi.mocked(apiFetch).mockClear()
    render(<Harness selectedBills={[{ id: 'a', priority: null, position: null, matchType: 'keyword', newMatchAt: '2026-06-20', triagedAt: null }]} />)
    const btn = screen.getByRole('button', { name: /Dismiss new matches/i })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(apiFetch).not.toHaveBeenCalledWith('/bills/bulk-dismiss', expect.anything())
  })

  it('leaves Apply enabled (given a staged change) when not demo-locked', () => {
    render(<Harness />)
    fireEvent.click(priorityPill())
    fireEvent.click(screen.getByText('High'))
    expect(screen.getByRole('button', { name: /Apply to 1 bill/i })).toBeEnabled()
  })
})

// Regression: a multi-select dropdown pill used to render permanently disabled in
// filter mode ("Select all N matching"), because /bills/bulk-values counted whole
// JSON-array combination strings rather than individual options. The write path
// always supported filter mode, so the field was greyed out purely for lack of a
// per-option distribution. The endpoint now returns `multiCustomFields`.
describe('BulkActionBar multi-select custom field (filter mode)', () => {
  const multiDef = {
    id: 'f1', name: 'Tags', type: 'dropdown' as const, options: ['a', 'b', 'c'], multiple: true,
  }

  function renderFilterMode(multiCustomFields: Record<string, Record<string, number>>, count: number) {
    vi.mocked(apiFetch).mockImplementation((path: string) => {
      if (path.startsWith('/bills/bulk-values')) {
        return Promise.resolve({
          count, priorities: {}, positions: {}, customFields: {}, multiCustomFields, nullMatchCount: 0,
        })
      }
      return Promise.resolve({ dismissed: 0 })
    })
    return render(
      <BulkActionBar
        selection={{ mode: 'filter' }}
        total={count}
        positionVocabulary={['Support', 'Oppose']}
        customFieldDefs={[multiDef]}
        currentFilters={noFilters}
        filterNewMatchCount={0}
        selectedBills={[]}
        onClearSelection={vi.fn()}
        onApplied={vi.fn()}
      />
    )
  }

  const tagsPill = () => screen.getByRole('button', { name: /Tags:/i })

  it('renders an enabled picker instead of a disabled button', async () => {
    renderFilterMode({ f1: { a: 3 } }, 3)
    await waitFor(() => expect(tagsPill()).toBeEnabled())
    expect(screen.queryByTitle('Select bills directly to bulk-edit multi-select fields')).not.toBeInTheDocument()
  })

  it('shows an option held by every matching bill as the current value', async () => {
    renderFilterMode({ f1: { a: 3 } }, 3)
    await waitFor(() => expect(tagsPill()).toHaveTextContent(/Tags:\s*a/))
  })

  it('reports "Multiple values" when an option is held by only some matching bills', async () => {
    renderFilterMode({ f1: { a: 3, b: 1 } }, 3)
    await waitFor(() => expect(tagsPill()).toHaveTextContent(/Tags:\s*Multiple values/))
  })

  it('reports "Not set" when no matching bill holds any option', async () => {
    renderFilterMode({}, 3)
    await waitFor(() => expect(tagsPill()).toHaveTextContent(/Tags:\s*Not set/))
  })

  it('stages an addition and sends it with the filter body', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderFilterMode({ f1: { a: 3 } }, 3)
    await waitFor(() => expect(tagsPill()).toBeEnabled())

    fireEvent.click(tagsPill())
    fireEvent.click(screen.getByText('b'))
    await waitFor(() => expect(tagsPill()).toHaveTextContent(/Tags:\s*Changed/))

    fireEvent.click(screen.getByRole('button', { name: /Apply to 3 bills/i }))
    await waitFor(() => {
      const call = vi.mocked(apiFetch).mock.calls.find(c => c[0] === '/bills/bulk')
      expect(call).toBeDefined()
      const body = JSON.parse((call![1] as { body: string }).body)
      expect(body.filter).toBeDefined()
      expect(body.ids).toBeUndefined()
      expect(body.customFields).toEqual([{ fieldId: 'f1', additions: ['b'], removals: [] }])
    })
  })
})

// Every one of these states used to render as "Not set" — a claim about data
// that was never fetched. The silent-failure case is the consequential one: it
// told an admin that no bill in the selection had a value, which is exactly the
// premise that invites bulk-overwriting real data.
describe('BulkActionBar unknown current values', () => {
  const multiDef = {
    id: 'f1', name: 'Tags', type: 'dropdown' as const, options: ['a', 'b'], multiple: true,
  }
  const singleDef = {
    id: 'f2', name: 'Stage', type: 'dropdown' as const, options: ['x', 'y'], multiple: false,
  }
  const binaryDef = { id: 'f3', name: 'Flag', type: 'binary' as const, options: null, multiple: false }

  function renderFilterMode(opts: { count?: number; fail?: boolean; hang?: boolean } = {}) {
    const { count = 5, fail = false, hang = false } = opts
    // Calls accumulate across tests in this file, and the assertions below look
    // up '/bills/bulk' by path — without this they can match an earlier test's.
    vi.mocked(apiFetch).mockClear()
    vi.mocked(apiFetch).mockImplementation((path: string) => {
      if (path.startsWith('/bills/bulk-values')) {
        if (fail) return Promise.reject(new Error('boom'))
        if (hang) return new Promise(() => {})
        return Promise.resolve({
          count, priorities: {}, positions: {}, customFields: {}, multiCustomFields: {}, nullMatchCount: 0,
        })
      }
      return Promise.resolve({ dismissed: 0 })
    })
    return render(
      <BulkActionBar
        selection={{ mode: 'filter' }}
        total={count}
        positionVocabulary={['Support', 'Oppose']}
        customFieldDefs={[multiDef, singleDef, binaryDef]}
        currentFilters={noFilters}
        filterNewMatchCount={0}
        selectedBills={[]}
        onClearSelection={vi.fn()}
        onApplied={vi.fn()}
      />
    )
  }

  it('reports a failed load instead of claiming every field is "Not set"', async () => {
    renderFilterMode({ fail: true })
    await waitFor(() => expect(screen.getByText('Could not load current values')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Stage:/i })).toHaveTextContent(/Stage:\s*—/)
    expect(screen.getByRole('button', { name: /Tags:/i })).toHaveTextContent(/Tags:\s*—/)
    expect(screen.getByRole('button', { name: /Priority:/i })).toHaveTextContent(/Priority:\s*—/)
    expect(screen.queryByText(/Not set/)).not.toBeInTheDocument()
  })

  it('says values are unavailable over the 1,000-bill cap', async () => {
    renderFilterMode({ count: 5000 })
    await waitFor(() =>
      expect(screen.getByText('Current values not shown above 1,000 bills')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Stage:/i })).toHaveTextContent(/Stage:\s*—/)
  })

  it('shows a loading note while the distribution is in flight', async () => {
    renderFilterMode({ hang: true })
    await waitFor(() => expect(screen.getByText('Loading current values…')).toBeInTheDocument())
  })

  it('clears the note and shows real values once loaded', async () => {
    renderFilterMode({ count: 5 })
    await waitFor(() => expect(screen.getByRole('button', { name: /Stage:/i })).toHaveTextContent(/Stage:\s*Not set/))
    expect(screen.queryByText('Loading current values…')).not.toBeInTheDocument()
    expect(screen.queryByText('Could not load current values')).not.toBeInTheDocument()
  })

  it('renders a binary field as indeterminate rather than unchecked when unknown', async () => {
    renderFilterMode({ fail: true })
    await waitFor(() => expect(screen.getByText('Could not load current values')).toBeInTheDocument())
    const box = screen.getByRole('checkbox', { name: /Flag/i }) as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(box.indeterminate).toBe(true)
  })

  it('lets "Not set" be staged deliberately when the initial value is unknown', async () => {
    renderFilterMode({ fail: true })
    await waitFor(() => expect(screen.getByText('Could not load current values')).toBeInTheDocument())

    const stagePill = () => screen.getByRole('button', { name: /Stage:/i })
    fireEvent.click(stagePill())
    fireEvent.click(screen.getByText('Not set'))
    // Previously this was classified as an undo against a guessed null initial
    // and silently dropped, making "Not set" unselectable.
    await waitFor(() => expect(stagePill()).toHaveTextContent(/Stage:\s*Not set/))
    expect(screen.getByTitle('Undo Stage change')).toBeInTheDocument()
  })

  it('stages an explicit removal for a multi option when the original is unknown', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderFilterMode({ fail: true })
    await waitFor(() => expect(screen.getByText('Could not load current values')).toBeInTheDocument())

    const tagsPill = () => screen.getByRole('button', { name: /Tags:/i })
    fireEvent.click(tagsPill())
    // Options start indeterminate, so the first click forces on and the second
    // forces off — never "reverting" to an original we never read.
    fireEvent.click(screen.getByText('a'))
    await waitFor(() => expect(tagsPill()).toHaveTextContent(/Tags:\s*Changed/))
    // The multi panel stays open across picks, so click the same option again.
    fireEvent.click(screen.getByText('a'))

    fireEvent.click(screen.getByRole('button', { name: /Apply to 5 bills/i }))
    await waitFor(() => {
      const call = vi.mocked(apiFetch).mock.calls.find(c => c[0] === '/bills/bulk')
      expect(call).toBeDefined()
      const body = JSON.parse((call![1] as { body: string }).body)
      expect(body.customFields).toEqual([{ fieldId: 'f1', additions: [], removals: ['a'] }])
    })
  })
})
