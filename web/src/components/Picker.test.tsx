import { useState } from 'react'
import { describe, it, expect } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { Picker } from './Picker'

function SingleHarness({ initial = null as string | null }) {
  const [value, setValue] = useState<string | null>(initial)
  return (
    <Picker
      mode="single"
      value={value}
      options={[
        { value: 'a', label: 'Apple' },
        { value: 'b', label: 'Banana' },
      ]}
      onChange={(v) => setValue(v)}
      emptyOption={{ label: 'Not set' }}
      trigger={({ toggle }) => (
        <button onClick={toggle}>{`val:${value ?? ''}`}</button>
      )}
    />
  )
}

function MultiHarness({
  initial = [] as string[],
  indeterminate,
}: {
  initial?: string[]
  indeterminate?: Set<string>
}) {
  const [value, setValue] = useState<string[]>(initial)
  return (
    <Picker
      mode="multi"
      value={value}
      indeterminate={indeterminate}
      options={[
        { value: 'a', label: 'Apple' },
        { value: 'b', label: 'Banana' },
        { value: 'c', label: 'Cherry' },
      ]}
      onChange={(v) => setValue(v)}
      trigger={({ toggle }) => (
        <button onClick={toggle}>{`val:${value.join(',')}`}</button>
      )}
    />
  )
}

describe('Picker — single mode', () => {
  it('opens when trigger clicked and shows options', () => {
    render(<SingleHarness />)
    expect(screen.queryByText('Apple')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Apple')).toBeInTheDocument()
    expect(screen.getByText('Banana')).toBeInTheDocument()
  })

  it('selects an option and updates value', () => {
    render(<SingleHarness />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Apple'))
    expect(screen.getByRole('button').textContent).toBe('val:a')
  })

  it('shows the empty option', () => {
    render(<SingleHarness initial="a" />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Not set'))
    expect(screen.getByRole('button').textContent).toBe('val:')
  })
})

describe('Picker — option descriptions', () => {
  function DescHarness() {
    const [value, setValue] = useState<string | null>(null)
    return (
      <Picker
        mode="single"
        value={value}
        options={[
          { value: 'a', label: 'Apple', description: 'A red fruit' },
          { value: 'b', label: 'Banana' },
        ]}
        onChange={(v) => setValue(v)}
        trigger={({ toggle }) => <button onClick={toggle}>open</button>}
      />
    )
  }

  it('reveals the description tooltip on row hover and hides it otherwise', () => {
    render(<DescHarness />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText('A red fruit')).not.toBeInTheDocument()
    fireEvent.mouseEnter(screen.getByText('Apple'))
    expect(screen.getByText('A red fruit')).toBeInTheDocument()
    fireEvent.mouseLeave(screen.getByText('Apple'))
    expect(screen.queryByText('A red fruit')).not.toBeInTheDocument()
  })
})

describe('Picker — multi mode', () => {
  it('toggles values without closing', () => {
    render(<MultiHarness />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Apple'))
    fireEvent.click(screen.getByText('Banana'))
    expect(screen.getByRole('button').textContent).toBe('val:a,b')
    expect(screen.getByText('Cherry')).toBeInTheDocument() // panel still open
  })

  it('unselects a checked option', () => {
    render(<MultiHarness initial={['a', 'b']} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Apple'))
    expect(screen.getByRole('button').textContent).toBe('val:b')
  })

  it('indeterminate option becomes checked on click (commits to "add")', () => {
    render(<MultiHarness indeterminate={new Set(['a'])} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Apple'))
    expect(screen.getByRole('button').textContent).toBe('val:a')
  })
})
