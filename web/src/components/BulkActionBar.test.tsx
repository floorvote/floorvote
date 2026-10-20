import { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { BulkActionBar, type Selection } from './BulkActionBar'
import { EMPTY_BILL_FILTER, parseBillFilter, serializeBillFilter } from '../../../shared/billFilter'

vi.mock('../lib/api', () => ({ apiFetch: vi.fn(() => Promise.resolve({ dismissed: 1 })) }))
import { apiFetch } from '../lib/api'

// Mutable flag so individual tests can opt into demoLocked without a
// module-level mock rewrite per test (mirrors Members.roleRename.test.tsx).
const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked }),
}))

const noFilters = EMPTY_BILL_FILTER

function Harness({
  selectedBills = [{ id: 'bill-1', priority: null as string | null, position: null as string | null }],
  onApplied = vi.fn(),
  onDraftsDeleted = vi.fn(),
}: {
  selectedBills?: Array<{ id: string; priority: string | null; position: string | null; matchType?: string | null; newMatchAt?: string | null; triagedAt?: string | null; isDraft?: boolean }>
  onApplied?: (updatedIds: string[] | 'filter', updates: Record<string, unknown>) => void
  onDraftsDeleted?: (ids: string[]) => void
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
      onDraftsDeleted={onDraftsDeleted}
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
        onDraftsDeleted={vi.fn()}
        selection={selection}
        total={682}
        positionVocabulary={['Support', 'Oppose']}
        customFieldDefs={[]}
        currentFilters={parseBillFilter('newMatches=1')}
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
          body: JSON.stringify({ filter: 'newMatches=1' }),
        }),
      )
    })
  })

  // CRITICAL 1 regression: the bulk filter body previously dropped `subject` entirely,
  // so a bulk action taken while a subject filter was active would silently
  // resolve against every bill matching the other filters — not just the ones
  // the admin saw and confirmed. The request body must carry the active subject
  // filter the same way it carries every other active filter.
  it('serializes the active subject filter into the bulk-dismiss request body', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const selection: Selection = { mode: 'filter' }
    render(
      <BulkActionBar
        onDraftsDeleted={vi.fn()}
        selection={selection}
        total={12}
        positionVocabulary={['Support', 'Oppose']}
        customFieldDefs={[]}
        currentFilters={parseBillFilter('newMatches=1&subject=UT%3AElection+Law')}
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
          body: JSON.stringify({ filter: 'subject=UT%3AElection+Law&newMatches=1' }),
        }),
      )
    })
  })

  it('still dismisses when the queue exceeds the 1,000 edit cap (overLimit)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const selection: Selection = { mode: 'filter' }
    render(
      <BulkActionBar
        onDraftsDeleted={vi.fn()}
        selection={selection}
        total={1500}
        positionVocabulary={['Support', 'Oppose']}
        customFieldDefs={[]}
        currentFilters={parseBillFilter('newMatches=1')}
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
        onDraftsDeleted={vi.fn()}
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

// A status and a stage are one filter fact on the server, matched as a union (#677), and a bulk action carries the
// same serialized bill filter the list sends, so "select all matching" acts on the bills the list shows.
describe('BulkActionBar with a status and a stage in the filter', () => {
  const filter = parseBillFilter('status=Passed&stage=vetoed')

  function renderWithFilter() {
    vi.mocked(apiFetch).mockClear()
    vi.mocked(apiFetch).mockImplementation((path: string) => {
      if (path.startsWith('/bills/bulk-values')) {
        return Promise.resolve({ count: 2, priorities: {}, positions: {}, customFields: {}, multiCustomFields: {}, nullMatchCount: 0 })
      }
      return Promise.resolve({ updated: 2 })
    })
    return render(
      <BulkActionBar
        onDraftsDeleted={vi.fn()}
        selection={{ mode: 'filter' }} total={2} positionVocabulary={['Support']} customFieldDefs={[]}
        currentFilters={filter} filterNewMatchCount={0} selectedBills={[]} onClearSelection={vi.fn()} onApplied={vi.fn()}
      />,
    )
  }

  it('asks for the pre-fill values of the same string the list sends', async () => {
    renderWithFilter()
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/bills/bulk-values?status=Passed&stage=vetoed'))
  })

  it('sends the same string as the filter of a bulk edit', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderWithFilter()
    fireEvent.click(priorityPill())
    fireEvent.click(screen.getByText('High'))
    fireEvent.click(screen.getByRole('button', { name: /Apply to 2 bills/i }))
    await waitFor(() => {
      const call = vi.mocked(apiFetch).mock.calls.find(c => c[0] === '/bills/bulk')
      expect(call).toBeDefined()
      expect(JSON.parse((call![1] as { body: string }).body).filter).toBe(serializeBillFilter(filter))
      expect(serializeBillFilter(filter)).toBe('status=Passed&stage=vetoed')
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
        onDraftsDeleted={vi.fn()}
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

// A bulk action sends the bill filter the way the list does: the shared serialize, a query string. The write
// (the filter in the request body) and the read that pre-populates the bulk-edit form (GET /bills/bulk-values)
// carry the same string, so the form never shows the values of one set of bills before a write to another.
describe('BulkActionBar sends the serialized bill filter', () => {
  const QS = 'status=Passed&stage=enacted&year=2026&state=UT&position=none&priority=high&tag=Water&subject=UT%3AElections&minRelevance=4&search=water&myBills=1&unvoted=1&newMatches=1&drafts=1&match=any&field.f1=Alpha&field.f1=__any__'

  function renderFilterMode(filter: ReturnType<typeof parseBillFilter>, total = 5) {
    vi.mocked(apiFetch).mockClear()
    vi.mocked(apiFetch).mockImplementation((path: string) => {
      if (path.startsWith('/bills/bulk-values')) {
        return Promise.resolve({ count: total, priorities: {}, positions: {}, customFields: {}, multiCustomFields: {}, nullMatchCount: 0 })
      }
      return Promise.resolve({ dismissed: 1, updated: 1 })
    })
    return render(
      <BulkActionBar
        onDraftsDeleted={vi.fn()}
        selection={{ mode: 'filter' }}
        total={total}
        positionVocabulary={['Support']}
        customFieldDefs={[]}
        currentFilters={filter}
        filterNewMatchCount={total}
        selectedBills={[]}
        onClearSelection={vi.fn()}
        onApplied={vi.fn()}
      />,
    )
  }
  const sent = (path: string) => {
    const call = vi.mocked(apiFetch).mock.calls.find(c => c[0] === path)
    return call ? JSON.parse((call[1] as { body: string }).body) as { filter?: unknown } : undefined
  }

  it('reads the bulk-edit form values with the filter as the shared serialize writes it', async () => {
    renderFilterMode(parseBillFilter(QS))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/bills/bulk-values?${serializeBillFilter(parseBillFilter(QS))}`))
  })

  it('sends match=any in the bulk-values query when the operator is set, and not otherwise', async () => {
    renderFilterMode(parseBillFilter('status=Passed&match=any'))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/bills/bulk-values?status=Passed&match=any'))
    cleanup()
    renderFilterMode(parseBillFilter('status=Passed'))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/bills/bulk-values?status=Passed'))
  })

  it('sends drafts=1 in the bulk-values query when the Drafts chip is on, and not otherwise', async () => {
    renderFilterMode(parseBillFilter('drafts=1'))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/bills/bulk-values?drafts=1'))
    cleanup()
    renderFilterMode(parseBillFilter('status=Passed'))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/bills/bulk-values?status=Passed'))
  })

  it('sends the serialized filter as a string in the bulk-dismiss body, every filter in it', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderFilterMode(parseBillFilter(QS))
    fireEvent.click(await screen.findByRole('button', { name: /Dismiss new matches/i }))
    await waitFor(() => expect(sent('/bills/bulk-dismiss')).toBeDefined())
    const body = sent('/bills/bulk-dismiss')!
    expect(typeof body.filter).toBe('string')
    expect(body.filter).toBe(serializeBillFilter(parseBillFilter(QS)))
    expect(parseBillFilter(body.filter as string)).toEqual(parseBillFilter(QS))
  })

  it('sends match=any in the filter when the operator is set, and omits it when not', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderFilterMode(parseBillFilter('newMatches=1&match=any'))
    fireEvent.click(await screen.findByRole('button', { name: /Dismiss new matches/i }))
    await waitFor(() => expect(sent('/bills/bulk-dismiss')).toBeDefined())
    expect(sent('/bills/bulk-dismiss')!.filter).toBe('newMatches=1&match=any')
    cleanup()
    renderFilterMode(parseBillFilter('newMatches=1'))
    fireEvent.click(await screen.findByRole('button', { name: /Dismiss new matches/i }))
    await waitFor(() => expect(sent('/bills/bulk-dismiss')).toBeDefined())
    expect(sent('/bills/bulk-dismiss')!.filter).toBe('newMatches=1')
  })

  // CRITICAL regression: the filter once had no `drafts` member, so "select all matching filters" with Drafts on
  // bulk-edited every bill, not just the drafts the admin saw (api/test/bills/draft-filter.test.ts is the server half).
  it('sends drafts=1 in the filter when the Drafts chip is on', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderFilterMode(parseBillFilter('newMatches=1&drafts=1'))
    fireEvent.click(await screen.findByRole('button', { name: /Dismiss new matches/i }))
    await waitFor(() => expect(sent('/bills/bulk-dismiss')).toBeDefined())
    expect(sent('/bills/bulk-dismiss')!.filter).toBe('newMatches=1&drafts=1')
  })

  it('sends the filter of a bulk edit the same way, as a string', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(apiFetch).mockClear()
    vi.mocked(apiFetch).mockImplementation((path: string) => {
      if (path.startsWith('/bills/bulk-values')) {
        return Promise.resolve({ count: 3, priorities: {}, positions: {}, customFields: {}, multiCustomFields: {}, nullMatchCount: 0 })
      }
      return Promise.resolve({ updated: 3 })
    })
    render(
      <BulkActionBar
        onDraftsDeleted={vi.fn()}
        selection={{ mode: 'filter' }}
        total={3}
        positionVocabulary={['Support']}
        customFieldDefs={[]}
        currentFilters={parseBillFilter('status=Passed&priority=high')}
        filterNewMatchCount={0}
        selectedBills={[]}
        onClearSelection={vi.fn()}
        onApplied={vi.fn()}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /Priority:/i }))
    fireEvent.click(screen.getByText('Low'))
    fireEvent.click(screen.getByRole('button', { name: /Apply to 3 bills/i }))
    await waitFor(() => expect(sent('/bills/bulk')).toBeDefined())
    expect(sent('/bills/bulk')!.filter).toBe('status=Passed&priority=high')
  })

  it('sends ids, and no filter, when bills are picked one by one', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(apiFetch).mockClear()
    vi.mocked(apiFetch).mockImplementation(() => Promise.resolve({ dismissed: 1 }))
    render(
      <BulkActionBar
        onDraftsDeleted={vi.fn()}
        selection={{ mode: 'ids', ids: new Set(['a']) }}
        total={1}
        positionVocabulary={['Support']}
        customFieldDefs={[]}
        currentFilters={parseBillFilter('status=Passed')}
        filterNewMatchCount={0}
        selectedBills={[{ id: 'a', priority: null, position: null, matchType: 'keyword', newMatchAt: '2026-01-01 00:00:00', triagedAt: null }]}
        onClearSelection={vi.fn()}
        onApplied={vi.fn()}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /Dismiss new matches/i }))
    await waitFor(() => expect(sent('/bills/bulk-dismiss')).toBeDefined())
    expect(sent('/bills/bulk-dismiss')).toEqual({ ids: ['a'] })
  })
})

// The confirmation used to read "• Tags: + a, b  − c", which admins could not
// decode. It now says what happens to each selected bill, in words.
describe('BulkActionBar multi-select confirmation wording', () => {
  const tagsDef = {
    id: 'f1', name: 'Tags', type: 'dropdown' as const, options: ['a', 'b', 'c', 'd', 'e'], multiple: true,
  }
  const stageDef = { id: 'f2', name: 'Stage', type: 'dropdown' as const, options: ['x', 'y'], multiple: false }
  const STAYS = 'Other values on each bill stay as they are.'

  // Every selected bill holds `d` and `e`: clicking those stages a removal,
  // clicking `a`, `b`, or `c` stages an addition.
  function renderWithAllHaving() {
    vi.mocked(apiFetch).mockClear()
    vi.mocked(apiFetch).mockImplementation((path: string) => {
      if (path.startsWith('/bills/bulk-values')) {
        return Promise.resolve({
          count: 3, priorities: {}, positions: {}, customFields: {},
          multiCustomFields: { f1: { d: 3, e: 3 } }, nullMatchCount: 0,
        })
      }
      return Promise.resolve({ dismissed: 0 })
    })
    return render(
      <BulkActionBar
        onDraftsDeleted={vi.fn()}
        selection={{ mode: 'filter' }}
        total={3}
        positionVocabulary={['Support', 'Oppose']}
        customFieldDefs={[tagsDef, stageDef]}
        currentFilters={noFilters}
        filterNewMatchCount={0}
        selectedBills={[]}
        onClearSelection={vi.fn()}
        onApplied={vi.fn()}
      />,
    )
  }

  const tagsPill = () => screen.getByRole('button', { name: /Tags:/i })

  async function stageTags(toggle: string[]) {
    renderWithAllHaving()
    await waitFor(() => expect(tagsPill()).toBeEnabled())
    fireEvent.click(tagsPill())
    for (const opt of toggle) fireEvent.click(screen.getByText(opt))
  }

  function applyAndCaptureConfirm(): string {
    // Spies on window.confirm persist across tests in this file; start from a clean count.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    confirm.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /Apply to 3 bills/i }))
    expect(confirm).toHaveBeenCalledTimes(1)
    return confirm.mock.calls[0][0] as string
  }

  async function confirmFor(toggle: string[]): Promise<string> {
    await stageTags(toggle)
    return applyAndCaptureConfirm()
  }

  it('says "add A" for a single addition', async () => {
    const msg = await confirmFor(['a'])
    expect(msg).toContain('• Tags: add a\n')
    expect(msg).not.toContain('remove')
  })

  it('joins two additions with "and"', async () => {
    const msg = await confirmFor(['a', 'b'])
    expect(msg).toContain('• Tags: add a and b\n')
  })

  it('joins three additions with a serial comma', async () => {
    const msg = await confirmFor(['a', 'b', 'c'])
    expect(msg).toContain('• Tags: add a, b, and c\n')
  })

  it('says "remove D" for a single removal', async () => {
    const msg = await confirmFor(['d'])
    expect(msg).toContain('• Tags: remove d\n')
    expect(msg).not.toContain('add')
  })

  it('joins two removals with "and"', async () => {
    const msg = await confirmFor(['d', 'e'])
    expect(msg).toContain('• Tags: remove d and e\n')
  })

  it('says "add A and B, remove D" when both are staged', async () => {
    const msg = await confirmFor(['a', 'b', 'd'])
    expect(msg).toContain('• Tags: add a and b, remove d\n')
  })

  it('says the other values stay put exactly once, under the list, however many multi-select changes', async () => {
    const msg = await confirmFor(['a', 'd'])
    expect(msg.split(STAYS)).toHaveLength(2)
    expect(msg.indexOf(STAYS)).toBeGreaterThan(msg.indexOf('• Tags:'))
  })

  it('uses no + or − signs for multi-select changes', async () => {
    const msg = await confirmFor(['a', 'b', 'd'])
    expect(msg).not.toMatch(/[+−]/)
  })

  it('does not mention other values when no multi-select change is staged', async () => {
    renderWithAllHaving()
    await waitFor(() => expect(tagsPill()).toBeEnabled())
    fireEvent.click(priorityPill())
    fireEvent.click(screen.getByText('High'))
    const msg = applyAndCaptureConfirm()
    expect(msg).toContain('• Priority → High')
    expect(msg).not.toContain(STAYS)
  })

  it('leaves priority, position, and single-value field lines unchanged beside a multi-select change', async () => {
    renderWithAllHaving()
    await waitFor(() => expect(tagsPill()).toBeEnabled())
    fireEvent.click(priorityPill())
    fireEvent.click(screen.getByText('High'))
    fireEvent.click(screen.getByRole('button', { name: /Position:/i }))
    fireEvent.click(screen.getByText('Support'))
    fireEvent.click(screen.getByRole('button', { name: /Stage:/i }))
    fireEvent.click(screen.getByText('x'))
    fireEvent.click(tagsPill())
    fireEvent.click(screen.getByText('a'))
    const msg = applyAndCaptureConfirm()
    expect(msg).toContain('• Priority → High\n')
    expect(msg).toContain('• Position → Support\n')
    expect(msg).toContain('• Stage → x\n')
    expect(msg).toContain('• Tags: add a\n')
    expect(msg.split(STAYS)).toHaveLength(2)
  })
})

// A staged priority promotes untracked bills (matchType null) to full tracking
// and queues them for AI analysis. The confirmation has always said how many;
// the bar says it too, before Apply is clicked, so the Apply label needs no
// ellipsis (AGENTS.md, "Button labels").
describe('BulkActionBar — AI analysis count before Apply', () => {
  const untracked = (id: string) => ({ id, priority: null, position: null, matchType: null })
  const tracked = (id: string) => ({ id, priority: null, position: null, matchType: 'manual' })
  const queuedText = () => screen.queryByText(/will be queued for AI analysis/i)

  function stagePriority(label: string) {
    fireEvent.click(priorityPill())
    fireEvent.click(screen.getByText(label))
  }

  it('shows how many selected bills will be queued once a priority is staged', () => {
    render(<Harness selectedBills={[untracked('a'), untracked('b'), tracked('c')]} />)
    stagePriority('High')
    expect(queuedText()).toHaveTextContent('2 will be queued for AI analysis')
  })

  it('shows the same count the confirmation uses', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<Harness selectedBills={[untracked('a'), untracked('b'), tracked('c')]} />)
    stagePriority('High')
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 3 bills' }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('2 of these bills will be promoted'))
    expect(queuedText()).toHaveTextContent('2 will be queued')
  })

  it('shows nothing before a priority is staged', () => {
    render(<Harness selectedBills={[untracked('a')]} />)
    expect(queuedText()).not.toBeInTheDocument()
  })

  it('shows nothing when every selected bill is already fully tracked', () => {
    render(<Harness selectedBills={[tracked('a'), tracked('b')]} />)
    stagePriority('High')
    expect(queuedText()).not.toBeInTheDocument()
  })

  it('shows nothing when only a position is staged', () => {
    render(<Harness selectedBills={[untracked('a')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Position:/i }))
    fireEvent.click(screen.getByText('Support'))
    expect(queuedText()).not.toBeInTheDocument()
  })

  it('uses the filter count when selecting by filter', async () => {
    vi.mocked(apiFetch).mockImplementation((path: string) => {
      if (path.startsWith('/bills/bulk-values')) {
        return Promise.resolve({
          count: 40, priorities: {}, positions: {}, customFields: {}, multiCustomFields: {}, nullMatchCount: 17,
        })
      }
      return Promise.resolve({})
    })
    render(
      <BulkActionBar
        onDraftsDeleted={vi.fn()}
        selection={{ mode: 'filter' }}
        total={40}
        positionVocabulary={['Support', 'Oppose']}
        customFieldDefs={[]}
        currentFilters={noFilters}
        filterNewMatchCount={0}
        selectedBills={[]}
        onClearSelection={vi.fn()}
        onApplied={vi.fn()}
      />
    )
    await waitFor(() => expect(priorityPill()).toBeEnabled())
    await screen.findByText(/Priority:\s*Not set/)
    stagePriority('High')
    expect(await screen.findByText(/17 will be queued for AI analysis/i)).toBeInTheDocument()
  })

  it('shows nothing beside the disabled Apply button when more than 1,000 bills are selected', () => {
    const many = Array.from({ length: 1001 }, (_, i) => untracked(`b${i}`))
    render(<Harness selectedBills={many} />)
    stagePriority('High')
    expect(screen.getByRole('button', { name: /Too many/ })).toBeDisabled()
    expect(queuedText()).not.toBeInTheDocument()
  })

  it('keeps the Apply label free of an ellipsis', () => {
    render(<Harness selectedBills={[untracked('a'), untracked('b')]} />)
    stagePriority('High')
    expect(screen.getByRole('button', { name: 'Apply to 2 bills' })).toBeInTheDocument()
  })
})

describe('BulkActionBar — delete drafts', () => {
  const deleteBtn = () => screen.queryByRole('button', { name: /Delete drafts/i })
  const bill = (id: string, isDraft: boolean) => ({ id, priority: null, position: null, matchType: 'manual', isDraft })
  type Preview = { drafts: number; filed: number; engagedDrafts: number; engagement: { votes: number; comments: number; notes: number; positions: number } }
  const preview = (drafts: number, filed = 0, engagedDrafts = 0, engagement: Partial<Preview['engagement']> = {}): Preview =>
    ({ drafts, filed, engagedDrafts, engagement: { votes: 0, comments: 0, notes: 0, positions: 0, ...engagement } })

  /** Answers POST /bills/bulk-delete: `onPreview` for a preview request, `onDelete` for the delete itself. */
  function mockBulkDelete(onPreview: (body: Record<string, unknown>) => unknown, onDelete: (body: Record<string, unknown>) => unknown = () => ({ deleted: [], skipped: [] })) {
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path !== '/bills/bulk-delete') return {} as never
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      return (body.preview ? onPreview(body) : onDelete(body)) as never
    })
  }
  const bulkDeleteBodies = () => vi.mocked(apiFetch).mock.calls
    .filter(c => c[0] === '/bills/bulk-delete')
    .map(c => JSON.parse((c[1] as RequestInit).body as string) as Record<string, unknown>)
  const deleteBodies = () => bulkDeleteBodies().filter(b => !b.preview)
  const previewBodies = () => bulkDeleteBodies().filter(b => b.preview)

  afterEach(() => {
    demoState.demoLocked = false
    vi.restoreAllMocks()
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockImplementation(() => Promise.resolve({ dismissed: 1 }))
  })

  describe('a selection of rows', () => {
    it('is hidden when no selected bill is a draft', () => {
      render(<Harness selectedBills={[bill('f1', false), bill('f2', false)]} />)
      expect(deleteBtn()).not.toBeInTheDocument()
    })

    it('is hidden for a bill whose isDraft flag is absent', () => {
      render(<Harness selectedBills={[{ id: 'a', priority: null, position: null }]} />)
      expect(deleteBtn()).not.toBeInTheDocument()
    })

    it('counts only the drafts in a mixed selection', () => {
      render(<Harness selectedBills={[bill('d1', true), bill('f1', false), bill('d2', true)]} />)
      expect(screen.getByRole('button', { name: /Delete drafts \(2\)/ })).toBeInTheDocument()
    })

    it('asks the server what the whole selection holds, then confirms with its numbers', async () => {
      mockBulkDelete(() => preview(2, 1))
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      render(<Harness selectedBills={[bill('d1', true), bill('f1', false), bill('d2', true)]} />)

      fireEvent.click(deleteBtn()!)

      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
      expect(previewBodies()).toEqual([{ ids: ['d1', 'f1', 'd2'], preview: true }])
      expect(confirm.mock.calls[0][0]).toBe("Delete 2 draft bills? This can't be undone. The 1 filed bill in your selection is not deleted.")
    })

    it('deletes nothing when cancelled', async () => {
      mockBulkDelete(() => preview(2))
      const onDraftsDeleted = vi.fn()
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      render(<Harness onDraftsDeleted={onDraftsDeleted} selectedBills={[bill('d1', true), bill('d2', true)]} />)

      fireEvent.click(deleteBtn()!)

      await waitFor(() => expect(confirm).toHaveBeenCalled())
      await waitFor(() => expect(deleteBtn()).toBeEnabled())
      expect(deleteBodies()).toEqual([])
      expect(onDraftsDeleted).not.toHaveBeenCalled()
    })

    it('names the work on engaged drafts in the confirm and sends includeEngaged', async () => {
      mockBulkDelete(() => preview(5, 0, 2, { votes: 4, comments: 3, positions: 1 }), b => ({ deleted: b.ids, skipped: [] }))
      const onDraftsDeleted = vi.fn()
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
      const ids = ['d1', 'd2', 'd3', 'd4', 'd5']
      render(<Harness onDraftsDeleted={onDraftsDeleted} selectedBills={ids.map(id => bill(id, true))} />)

      fireEvent.click(deleteBtn()!)

      await waitFor(() => expect(onDraftsDeleted).toHaveBeenCalledWith(ids))
      expect(confirm.mock.calls[0][0]).toBe(
        "Delete 5 draft bills? 2 of them have your team's work on them: 4 votes, 3 comments, and 1 position, which will be deleted too. To keep it, link those drafts to their filed bills instead. This can't be undone.",
      )
      expect(deleteBodies()).toEqual([{ ids, includeEngaged: true }])
    })

    it('sends no includeEngaged when the preview found no engagement, and only the drafts of a mixed selection', async () => {
      mockBulkDelete(() => preview(2, 1), () => ({ deleted: ['d1', 'd2'], skipped: [] }))
      const onDraftsDeleted = vi.fn()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      render(<Harness onDraftsDeleted={onDraftsDeleted} selectedBills={[bill('d1', true), bill('f1', false), bill('d2', true)]} />)

      fireEvent.click(deleteBtn()!)

      await waitFor(() => expect(onDraftsDeleted).toHaveBeenCalledWith(['d1', 'd2']))
      expect(deleteBodies()).toEqual([{ ids: ['d1', 'd2'] }])
    })

    it('uses the single-draft wording for one selected draft', async () => {
      mockBulkDelete(() => preview(1, 0, 1, { votes: 3, comments: 2, notes: 1 }))
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      render(<Harness selectedBills={[bill('d1', true)]} />)

      fireEvent.click(deleteBtn()!)

      await waitFor(() => expect(confirm).toHaveBeenCalled())
      expect(confirm.mock.calls[0][0]).toBe(
        "Delete this draft bill? Your team's 3 votes, 2 comments, and 1 note on it will be deleted too. To keep them, link the draft to its filed bill instead. This can't be undone.",
      )
    })

    it('shows a failed preview in the bar, asks nothing, and deletes nothing', async () => {
      mockBulkDelete(() => { throw new Error('Preview unavailable') })
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
      render(<Harness selectedBills={[bill('d1', true)]} />)

      fireEvent.click(deleteBtn()!)

      expect(await screen.findByText('Preview unavailable')).toBeInTheDocument()
      expect(confirm).not.toHaveBeenCalled()
      expect(deleteBodies()).toEqual([])
      expect(deleteBtn()).toBeEnabled()
    })

    it('reports a draft another admin already deleted as gone, and says nothing is wrong', async () => {
      mockBulkDelete(() => preview(2), () => ({ deleted: ['d1'], skipped: [{ id: 'd2', reason: 'not_found' }] }))
      const onDraftsDeleted = vi.fn()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      render(<Harness onDraftsDeleted={onDraftsDeleted} selectedBills={[bill('d1', true), bill('d2', true)]} />)

      fireEvent.click(deleteBtn()!)

      await waitFor(() => expect(onDraftsDeleted).toHaveBeenCalledWith(['d1', 'd2']))
      expect(screen.queryByText(/kept|could not/i)).not.toBeInTheDocument()
    })

    it('names a draft that gained engagement after a clean preview and was kept', async () => {
      mockBulkDelete(() => preview(2), () => ({ deleted: ['d1'], skipped: [{ id: 'd2', reason: 'engaged' }] }))
      const onDraftsDeleted = vi.fn()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      render(<Harness onDraftsDeleted={onDraftsDeleted} selectedBills={[bill('d1', true), bill('d2', true)]} />)

      fireEvent.click(deleteBtn()!)

      await waitFor(() => expect(onDraftsDeleted).toHaveBeenCalledWith(['d1']))
      expect(await screen.findByText(/1 draft was kept: it gained votes, positions, comments, or notes since you asked\. Try again to see what goes with it\./i)).toBeInTheDocument()
    })

    it('names drafts the server could not delete in the bar', async () => {
      mockBulkDelete(() => preview(1), () => ({ deleted: [], skipped: [{ id: 'd1', reason: 'error' }] }))
      const onDraftsDeleted = vi.fn()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      render(<Harness onDraftsDeleted={onDraftsDeleted} selectedBills={[bill('d1', true)]} />)

      fireEvent.click(deleteBtn()!)

      expect(await screen.findByText(/1 draft could not be deleted/i)).toBeInTheDocument()
      expect(onDraftsDeleted).not.toHaveBeenCalled()
    })

    it('shows the error in the bar and removes nothing when the delete fails', async () => {
      mockBulkDelete(() => preview(1), () => { throw new Error('Server on fire') })
      const onDraftsDeleted = vi.fn()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      render(<Harness onDraftsDeleted={onDraftsDeleted} selectedBills={[bill('d1', true)]} />)

      fireEvent.click(deleteBtn()!)

      expect(await screen.findByText('Server on fire')).toBeInTheDocument()
      expect(onDraftsDeleted).not.toHaveBeenCalled()
      expect(deleteBtn()).toBeEnabled()
    })

    it('disables itself while the request is in flight, so a second click sends nothing', async () => {
      let finish: (v: unknown) => void = () => {}
      mockBulkDelete(() => preview(1), () => new Promise(res => { finish = res }))
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      render(<Harness selectedBills={[bill('d1', true)]} />)

      fireEvent.click(deleteBtn()!)
      await waitFor(() => expect(deleteBodies()).toHaveLength(1))
      expect(deleteBtn()).toBeDisabled()
      fireEvent.click(deleteBtn()!)

      expect(previewBodies()).toHaveLength(1)
      expect(deleteBodies()).toHaveLength(1)
      finish({ deleted: ['d1'], skipped: [] })
    })

    it('is disabled with the locked hover in a demo, and sends nothing', () => {
      demoState.demoLocked = true
      vi.mocked(apiFetch).mockClear()
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
      render(<Harness selectedBills={[bill('d1', true)]} />)

      const btn = screen.getByRole('button', { name: /Delete drafts/i })
      expect(btn).toBeDisabled()
      expect(btn).toHaveAttribute('title', 'Locked in demo mode')
      fireEvent.click(btn)

      expect(confirm).not.toHaveBeenCalled()
      expect(bulkDeleteBodies()).toEqual([])
    })
  })

  describe('select all matching the filters', () => {
    const DRAFTS = parseBillFilter(new URLSearchParams('drafts=1&state=RI'))
    function renderFilterMode(opts: { filters?: typeof DRAFTS; total?: number; onDraftsDeleted?: (ids: string[]) => void; onClearSelection?: () => void } = {}) {
      return render(
        <BulkActionBar
          selection={{ mode: 'filter' }}
          total={opts.total ?? 5}
          positionVocabulary={[]}
          customFieldDefs={[]}
          currentFilters={opts.filters ?? DRAFTS}
          filterNewMatchCount={0}
          selectedBills={[]}
          onClearSelection={opts.onClearSelection ?? vi.fn()}
          onApplied={vi.fn()}
          onDraftsDeleted={opts.onDraftsDeleted ?? vi.fn()}
        />,
      )
    }

    it('is hidden, and asks nothing, without the Drafts filter', async () => {
      mockBulkDelete(() => preview(5))
      renderFilterMode({ filters: noFilters })
      await waitFor(() => expect(apiFetch).toHaveBeenCalled())
      expect(deleteBtn()).not.toBeInTheDocument()
      expect(previewBodies()).toEqual([])
    })

    it('shows with the Drafts filter on, counting the drafts the preview finds', async () => {
      mockBulkDelete(() => preview(7))
      renderFilterMode()
      expect(await screen.findByRole('button', { name: /Delete drafts \(7\)/ })).toBeInTheDocument()
      expect(previewBodies()).toEqual([{ filter: serializeBillFilter(DRAFTS), preview: true }])
    })

    it('stays hidden when the preview finds no drafts, or fails', async () => {
      mockBulkDelete(() => preview(0))
      const { unmount } = renderFilterMode()
      await waitFor(() => expect(previewBodies()).toHaveLength(1))
      expect(deleteBtn()).not.toBeInTheDocument()
      unmount()

      mockBulkDelete(() => { throw new Error('no') })
      renderFilterMode()
      await waitFor(() => expect(previewBodies()).toHaveLength(1))
      expect(deleteBtn()).not.toBeInTheDocument()
    })

    it('asks nothing and shows nothing past 1,000 bills', async () => {
      mockBulkDelete(() => preview(1500))
      renderFilterMode({ total: 1500 })
      await waitFor(() => expect(screen.getByText(/Current values not shown above 1,000 bills/)).toBeInTheDocument())
      expect(previewBodies()).toEqual([])
      expect(deleteBtn()).not.toBeInTheDocument()
    })

    it('confirms with a fresh preview, deletes by the filter with includeEngaged, and ends the selection', async () => {
      let previews = 0
      mockBulkDelete(
        () => (++previews === 1 ? preview(3) : preview(3, 0, 1, { notes: 2 })),
        () => ({ deleted: ['d1', 'd2', 'd3'], skipped: [] }),
      )
      const onDraftsDeleted = vi.fn()
      const onClearSelection = vi.fn()
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
      renderFilterMode({ onDraftsDeleted, onClearSelection })

      fireEvent.click(await screen.findByRole('button', { name: /Delete drafts \(3\)/ }))

      await waitFor(() => expect(onDraftsDeleted).toHaveBeenCalledWith(['d1', 'd2', 'd3']))
      expect(confirm.mock.calls[0][0]).toBe(
        "Delete 3 draft bills? 1 of them has your team's work on it: 2 notes, which will be deleted too. To keep it, link that draft to its filed bill instead. This can't be undone.",
      )
      expect(deleteBodies()).toEqual([{ filter: serializeBillFilter(DRAFTS), includeEngaged: true }])
      expect(onClearSelection).toHaveBeenCalled()
    })

    it('keeps the selection when some drafts could not be deleted', async () => {
      mockBulkDelete(() => preview(2), () => ({ deleted: ['d1'], skipped: [{ id: 'd2', reason: 'error' }] }))
      const onClearSelection = vi.fn()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      renderFilterMode({ onClearSelection })

      fireEvent.click(await screen.findByRole('button', { name: /Delete drafts \(2\)/ }))

      expect(await screen.findByText(/1 draft could not be deleted/i)).toBeInTheDocument()
      expect(onClearSelection).not.toHaveBeenCalled()
    })

    it('deletes nothing when cancelled', async () => {
      mockBulkDelete(() => preview(2))
      vi.spyOn(window, 'confirm').mockReturnValue(false)
      renderFilterMode()

      fireEvent.click(await screen.findByRole('button', { name: /Delete drafts \(2\)/ }))

      await waitFor(() => expect(previewBodies()).toHaveLength(2))
      expect(deleteBodies()).toEqual([])
    })
  })
})
