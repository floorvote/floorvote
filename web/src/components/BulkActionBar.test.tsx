import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BulkActionBar, type Selection } from './BulkActionBar'

const noFilters = {
  status: [], priority: [], position: [], year: [], state: [], tag: [],
  q: '', minRelevance: 0, myBills: false, unvoted: false, cf: {},
}

function Harness({
  selectedBills = [{ id: 'bill-1', priority: null as string | null, position: null as string | null }],
}: {
  selectedBills?: Array<{ id: string; priority: string | null; position: string | null }>
}) {
  const [selection] = useState<Selection>({ mode: 'ids', ids: new Set(selectedBills.map(b => b.id)) })
  return (
    <BulkActionBar
      selection={selection}
      total={selectedBills.length}
      positionVocabulary={['Support', 'Oppose']}
      customFieldDefs={[]}
      currentFilters={noFilters}
      selectedBills={selectedBills}
      onClearSelection={vi.fn()}
      onApplied={vi.fn()}
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
