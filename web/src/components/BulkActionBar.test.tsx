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
  status: [], priority: [], position: [], year: [], state: [], tag: [],
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
