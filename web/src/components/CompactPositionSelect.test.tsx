import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CompactPositionSelect } from './CompactPositionSelect'

const apiFetchMock = vi.fn()
vi.mock('../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

const OPTIONS = ['Support', 'Oppose', 'Monitor']
const select = () => screen.getByRole('combobox', { name: 'Position' }) as HTMLSelectElement
const optionLabels = () => within(select()).getAllByRole('option').map(o => o.textContent)

describe('CompactPositionSelect', () => {
  beforeEach(() => { apiFetchMock.mockReset() })

  describe('an empty position', () => {
    it('reads "Set position" when closed, not "Not set"', () => {
      render(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={vi.fn()} />)
      expect(select()).toHaveDisplayValue('Set position')
      expect(screen.queryByText('Not set')).toBeNull()
    })

    it('lists "No position" first, then the vocabulary, with no "Set position" entry', () => {
      render(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={vi.fn()} />)
      expect(optionLabels()).toEqual(['No position', 'Support', 'Oppose', 'Monitor'])
      expect(optionLabels()).not.toContain('Set position')
    })

    it('keeps the closed label out of the menu: a hidden, disabled option', () => {
      render(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={vi.fn()} />)
      const all = within(select()).getAllByRole('option', { hidden: true }) as HTMLOptionElement[]
      expect(all.map(o => o.textContent)).toEqual(['Set position', 'No position', 'Support', 'Oppose', 'Monitor'])
      expect(all[0]).toHaveAttribute('hidden')
      expect(all[0].disabled).toBe(true)
      expect(all[0].selected).toBe(true)
      for (const o of all.slice(1)) { expect(o.disabled).toBe(false); expect(o).not.toHaveAttribute('hidden') }
    })

    it('announces "Set position" as its value, with "No position" a separate unselected choice', () => {
      render(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={vi.fn()} />)
      expect(select().selectedOptions).toHaveLength(1)
      expect(select().selectedOptions[0].textContent).toBe('Set position')
      expect((screen.getByRole('option', { name: 'No position' }) as HTMLOptionElement).selected).toBe(false)
    })

    it('choosing "No position" when there is no position makes no request', async () => {
      const onChange = vi.fn()
      render(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={onChange} />)
      fireEvent.change(select(), { target: { value: '__none__' } })
      await Promise.resolve()
      expect(apiFetchMock).not.toHaveBeenCalled()
      expect(onChange).not.toHaveBeenCalled()
      expect(select()).toHaveDisplayValue('Set position')
    })

    it('tells a vocabulary entry named "No Position" apart from the menu\'s "No position" choice', async () => {
      apiFetchMock.mockResolvedValue({})
      const onChange = vi.fn()
      const user = userEvent.setup()
      render(<CompactPositionSelect billId="b1" current="Support" options={['Support', 'No Position']} onChange={onChange} />)
      expect(optionLabels()).toEqual(['No position', 'Support', 'No Position'])
      await user.selectOptions(select(), 'No Position')
      await waitFor(() => expect(onChange).toHaveBeenCalledWith('No Position'))
      expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/position', { method: 'POST', body: JSON.stringify({ position: 'No Position' }) })
    })
  })

  describe('a set position', () => {
    it('shows the position and lists "No position" first', () => {
      render(<CompactPositionSelect billId="b1" current="Oppose" options={OPTIONS} onChange={vi.fn()} />)
      expect(select()).toHaveDisplayValue('Oppose')
      expect(optionLabels()).toEqual(['No position', 'Support', 'Oppose', 'Monitor'])
    })

    it('choosing "No position" sends the DELETE and reports null, then the closed control reads "Set position"', async () => {
      apiFetchMock.mockResolvedValue({})
      const onChange = vi.fn()
      const { rerender } = render(<CompactPositionSelect billId="b1" current="Support" options={OPTIONS} onChange={onChange} />)
      fireEvent.change(select(), { target: { value: '__none__' } })
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(null))
      expect(apiFetchMock).toHaveBeenCalledTimes(1)
      expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/position', { method: 'DELETE' })
      rerender(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={onChange} />)
      expect(select()).toHaveDisplayValue('Set position')
    })

    it('picking "No position" by name clears it the same way', async () => {
      apiFetchMock.mockResolvedValue({})
      const onChange = vi.fn()
      const user = userEvent.setup()
      render(<CompactPositionSelect billId="b1" current="Monitor" options={OPTIONS} onChange={onChange} />)
      await user.selectOptions(select(), 'No position')
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(null))
    })

    it('choosing a position still POSTs it', async () => {
      apiFetchMock.mockResolvedValue({})
      const onChange = vi.fn()
      render(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={onChange} />)
      fireEvent.change(select(), { target: { value: 'Oppose' } })
      await waitFor(() => expect(onChange).toHaveBeenCalledWith('Oppose'))
      expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/position', { method: 'POST', body: JSON.stringify({ position: 'Oppose' }) })
    })
  })

  it('stops the row from navigating: clicks and mousedowns do not bubble', () => {
    const parentClick = vi.fn()
    const parentMouseDown = vi.fn()
    render(
      <div role="presentation" onClick={parentClick} onMouseDown={parentMouseDown}>
        <CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={vi.fn()} />
      </div>,
    )
    fireEvent.mouseDown(select())
    fireEvent.click(select())
    expect(parentClick).not.toHaveBeenCalled()
    expect(parentMouseDown).not.toHaveBeenCalled()
  })
})
