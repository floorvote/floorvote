import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BillPicker, type BillOption } from './BillPicker'

const options: BillOption[] = [
  { id: '1', billNumber: 'H 100', title: 'Elections modernization', state: 'RI', isDraft: false },
  { id: '2', billNumber: 'S 22', title: 'Ballot drop boxes', state: 'RI', isDraft: false },
  { id: '3', billNumber: 'H 305', title: 'Voter rolls', state: 'MA', isDraft: false },
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

/**
 * Draft marker. /calendar/bill-options already selected bills.isDraft; the
 * field just never reached BillOption, so a selected draft got the solid navy
 * badge here while /bills and the feed showed it dashed.
 *
 * The selected pills are a wrapping row of badge + remove button inside a form
 * field, so they carry the screen-reader label rather than a visible chip; the
 * dropdown rows are full-width and render no badge at all, so they get the
 * plain word.
 */
const draftOptions: BillOption[] = [
  { id: 'd1', billNumber: 'D 1', title: 'Pre-filed measure', state: 'RI', isDraft: true },
  { id: 'f1', billNumber: 'F 1', title: 'Filed measure', state: 'RI', isDraft: false },
]

describe('BillPicker draft marker', () => {
  it('renders the dashed badge for a selected draft', () => {
    render(<BillPicker options={draftOptions} value={['d1']} onChange={vi.fn()} multiState={false} />)
    const badge = screen.getByText('D 1')
    expect(/dashed/.test(badge.style.border)).toBe(true)
    expect(badge.style.background === 'transparent' || badge.style.background === '').toBe(true)
  })

  it('renders the solid badge for a selected filed bill', () => {
    render(<BillPicker options={draftOptions} value={['f1']} onChange={vi.fn()} multiState={false} />)
    expect(/dashed/.test(screen.getByText('F 1').style.border)).toBe(false)
  })

  it('names the draft in the selected pill accessible name, without a visible chip', () => {
    const { container } = render(<BillPicker options={draftOptions} value={['d1']} onChange={vi.fn()} multiState={false} />)
    expect(container.textContent).toMatch(/draft/i)
    expect(screen.queryByText('Draft')).toBeNull()
  })

  it('says nothing about drafts when only a filed bill is selected', () => {
    const { container } = render(<BillPicker options={draftOptions} value={['f1']} onChange={vi.fn()} multiState={false} />)
    expect(container.textContent).not.toMatch(/draft/i)
  })

  it('labels the draft row in the dropdown, and only that row', () => {
    render(<BillPicker options={draftOptions} value={[]} onChange={vi.fn()} multiState={false} />)
    fireEvent.change(screen.getByPlaceholderText('Search bills…'), { target: { value: 'measure' } })
    const rows = screen.getAllByRole('button')
    const draftRow = rows.find(r => r.textContent?.includes('D 1'))!
    const filedRow = rows.find(r => r.textContent?.includes('F 1'))!
    expect(draftRow.textContent).toMatch(/Draft/)
    expect(filedRow.textContent).not.toMatch(/Draft/)
  })
})
