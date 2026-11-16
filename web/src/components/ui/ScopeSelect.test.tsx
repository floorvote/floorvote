import { useState } from 'react'
import { describe, it, expect } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { ScopeSelect, type ScopeSelectOption } from './ScopeSelect'

const OPTS: ScopeSelectOption[] = [
  { value: 'a', label: 'Option A' },
  { value: 'b', label: 'Option B', description: 'the second one' },
]

function Harness({ initial = 'a' }: { initial?: string }) {
  const [v, setV] = useState(initial)
  return <ScopeSelect options={OPTS} value={v} onChange={setV} defaultValue="a" />
}

describe('ScopeSelect', () => {
  it('shows the current option label on the trigger', () => {
    render(<Harness />)
    expect(screen.getByRole('button')).toHaveTextContent('Option A')
  })

  it('opens and selects an option, updating the trigger label', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Option B'))
    expect(screen.getByRole('button')).toHaveTextContent('Option B')
  })

  it('reveals an option description on hover', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText('the second one')).not.toBeInTheDocument()
    fireEvent.mouseEnter(screen.getByText('Option B'))
    expect(screen.getByText('the second one')).toBeInTheDocument()
  })

  it('names the button and its options by ariaLabel, keeping the current choice in the button name', () => {
    render(<ScopeSelect options={OPTS} value="b" onChange={() => {}} ariaLabel="How often" />)
    fireEvent.click(screen.getByRole('button', { name: 'How often: Option B' }))
    expect(screen.getByRole('radiogroup', { name: 'How often' })).toBeInTheDocument()
  })
})
