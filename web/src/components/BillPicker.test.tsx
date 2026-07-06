import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BillPicker, type BillOption } from './BillPicker'

const options: BillOption[] = [
  { id: '1', billNumber: 'H 100', title: 'Elections modernization', state: 'RI' },
  { id: '2', billNumber: 'S 22', title: 'Ballot drop boxes', state: 'RI' },
  { id: '3', billNumber: 'H 305', title: 'Voter rolls', state: 'MA' },
]

describe('BillPicker', () => {
  it('filters by number, title, and state', () => {
    render(<BillPicker options={options} value={[]} onChange={vi.fn()} multiState />)
    const input = screen.getByPlaceholderText(/search bills/i)
    fireEvent.change(input, { target: { value: 'drop' } })
    expect(screen.getByText(/Ballot drop boxes/)).toBeInTheDocument()
    expect(screen.queryByText(/Voter rolls/)).toBeNull()
    fireEvent.change(input, { target: { value: 'MA' } })
    expect(screen.getByText(/Voter rolls/)).toBeInTheDocument()
  })

  it('selecting adds a chip; clicking × removes it', () => {
    const onChange = vi.fn()
    const { rerender } = render(<BillPicker options={options} value={[]} onChange={onChange} multiState />)
    fireEvent.change(screen.getByPlaceholderText(/search bills/i), { target: { value: 'H 100' } })
    fireEvent.click(screen.getByText(/Elections modernization/))
    expect(onChange).toHaveBeenCalledWith(['1'])

    rerender(<BillPicker options={options} value={['1']} onChange={onChange} multiState />)
    expect(screen.getByLabelText(/remove H 100/i)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText(/remove H 100/i))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('supports keyboard navigation: arrow down + Enter selects', () => {
    const onChange = vi.fn()
    render(<BillPicker options={options} value={[]} onChange={onChange} multiState />)
    const input = screen.getByPlaceholderText(/search bills/i)
    fireEvent.change(input, { target: { value: 'H' } }) // matches H 100 and H 305
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // highlight first
    fireEvent.keyDown(input, { key: 'Enter' })      // select highlighted
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toHaveLength(1) // one id selected
  })

  it('Enter with no explicit highlight selects the first match', () => {
    const onChange = vi.fn()
    render(<BillPicker options={options} value={[]} onChange={onChange} multiState />)
    const input = screen.getByPlaceholderText(/search bills/i)
    fireEvent.change(input, { target: { value: 'drop' } }) // only S 22
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['2'])
  })

  it('replaces selection in single mode instead of appending', () => {
    const onChange = vi.fn()
    render(<BillPicker options={options} value={['1']} onChange={onChange} multiState single />)
    const input = screen.getByPlaceholderText('Search bills…')
    fireEvent.change(input, { target: { value: options[1].billNumber } }) // 'S 22'
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith([options[1].id]) // replaced, not ['1', '2']
  })
})
