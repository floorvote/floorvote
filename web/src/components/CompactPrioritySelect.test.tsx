import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CompactPrioritySelect } from './CompactPrioritySelect'
import { expectAmber, expectNotAmber, expectPlainEmpty, fontSizeOf } from '../test/amberStyle'

const apiFetchMock = vi.fn()
vi.mock('../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

const optionLabels = () => within(screen.getByRole('combobox')).getAllByRole('option').map(o => o.textContent)

describe('CompactPrioritySelect', () => {
  // Braces matter: a function returned from beforeEach is run as a cleanup, and mockReset returns the mock.
  beforeEach(() => { apiFetchMock.mockReset() })

  it('passes the PATCH response (promoted) as the second onChange arg', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'high', promoted: true })
    const onChange = vi.fn()
    render(<CompactPrioritySelect billId="b1" current={null} onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'high' } })
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange).toHaveBeenCalledWith('high', { priority: 'high', promoted: true })
  })

  it('reports promoted:false when central did not promote', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'low', promoted: false })
    const onChange = vi.fn()
    render(<CompactPrioritySelect billId="b1" current={null} onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'low' } })
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange).toHaveBeenCalledWith('low', { priority: 'low', promoted: false })
  })

  describe('an empty priority', () => {
    it('reads "Set priority", not "Not set"', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
      expect(screen.getByRole('combobox')).toHaveDisplayValue('Set priority')
      expect(screen.queryByText('Not set')).toBeNull()
    })

    it('lists the three priorities after the placeholder, with no Dismiss', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
      expect(optionLabels()).toEqual(['Set priority', 'High Priority', 'Medium Priority', 'Low Priority'])
    })

    it('stays white with a default border, not amber', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
      expectPlainEmpty(screen.getByRole('combobox'))
    })

    it('still honors a caller-supplied placeholder', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} placeholder="Pick one" />)
      expect(screen.getByRole('combobox')).toHaveDisplayValue('Pick one')
    })
  })

  describe('a set priority', () => {
    it('shows the priority and has no Dismiss option', () => {
      render(<CompactPrioritySelect billId="b1" current="medium" onChange={vi.fn()} />)
      expect(screen.getByRole('combobox')).toHaveDisplayValue('Medium Priority')
      expect(optionLabels()).toEqual(['Set priority', 'High Priority', 'Medium Priority', 'Low Priority'])
    })

    it('choosing "Set priority" clears the priority with a null PATCH', async () => {
      apiFetchMock.mockResolvedValue({ priority: null })
      const onChange = vi.fn()
      render(<CompactPrioritySelect billId="b1" current="high" onChange={onChange} />)
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(null, expect.anything()))
      expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/priority', { method: 'PATCH', body: JSON.stringify({ priority: null }) })
    })
  })

  describe('an untriaged new match', () => {
    const renderNew = (props: Partial<React.ComponentProps<typeof CompactPrioritySelect>> = {}) => {
      const onChange = vi.fn()
      const onDismiss = vi.fn()
      render(<CompactPrioritySelect billId="b1" current={null} onChange={onChange} newMatch onDismiss={onDismiss} {...props} />)
      return { onChange, onDismiss }
    }

    it('reads "New · Set priority"', () => {
      renderNew()
      expect(screen.getByRole('combobox')).toHaveDisplayValue('New · Set priority')
    })

    it('is amber: the amber fill, dark amber text, and amber border', () => {
      renderNew()
      expectAmber(screen.getByRole('combobox'))
    })

    it('lists the priorities, then Dismiss as the last option', () => {
      renderNew()
      expect(optionLabels()).toEqual([
        'New · Set priority', 'High Priority', 'Medium Priority', 'Low Priority', 'Dismiss (reviewed, no priority)',
      ])
    })

    it('says in its accessible name that it is a new match', () => {
      renderNew()
      expect(screen.getByRole('combobox', { name: /priority/i })).toHaveAccessibleName(/new match/i)
    })

    it('choosing a priority PATCHes it and reports it through onChange, with no dismiss call', async () => {
      apiFetchMock.mockResolvedValue({ priority: 'high', promoted: true })
      const { onChange, onDismiss } = renderNew()
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'high' } })
      await waitFor(() => expect(onChange).toHaveBeenCalledWith('high', { priority: 'high', promoted: true }))
      expect(apiFetchMock).toHaveBeenCalledTimes(1)
      expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/priority', { method: 'PATCH', body: JSON.stringify({ priority: 'high' }) })
      expect(onDismiss).not.toHaveBeenCalled()
    })

    it('choosing Dismiss calls the triage-dismiss endpoint, then onDismiss, and sets no priority', async () => {
      apiFetchMock.mockResolvedValue({ ok: true })
      const { onChange, onDismiss } = renderNew()
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dismiss' } })
      await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1))
      expect(apiFetchMock).toHaveBeenCalledTimes(1)
      expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/triage-dismiss', { method: 'PATCH' })
      expect(onChange).not.toHaveBeenCalled()
    })

    it('does not call onDismiss when the dismiss request fails', async () => {
      apiFetchMock.mockRejectedValue(new Error('boom'))
      const { onDismiss } = renderNew()
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dismiss' } })
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled())
      await Promise.resolve()
      expect(onDismiss).not.toHaveBeenCalled()
    })

    it('does not call onDismiss before the dismiss request resolves', async () => {
      let resolve!: (v: unknown) => void
      apiFetchMock.mockReturnValue(new Promise(r => { resolve = r }))
      const { onDismiss } = renderNew()
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dismiss' } })
      expect(onDismiss).not.toHaveBeenCalled()
      resolve({ ok: true })
      await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1))
    })

    it('can be driven from the keyboard: Tab focuses it, and picking Dismiss triages', async () => {
      apiFetchMock.mockResolvedValue({ ok: true })
      const user = userEvent.setup()
      const { onDismiss } = renderNew()
      await user.tab()
      expect(screen.getByRole('combobox')).toHaveFocus()
      await user.selectOptions(screen.getByRole('combobox'), 'dismiss')
      await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1))
    })

    it('can be driven from the keyboard: picking a priority sets it', async () => {
      apiFetchMock.mockResolvedValue({ priority: 'low' })
      const user = userEvent.setup()
      const { onChange } = renderNew()
      await user.tab()
      await user.selectOptions(screen.getByRole('combobox'), 'low')
      await waitFor(() => expect(onChange).toHaveBeenCalledWith('low', expect.anything()))
    })

    it('stops the row from navigating: clicks and mousedowns do not bubble', () => {
      const parentClick = vi.fn()
      const parentMouseDown = vi.fn()
      render(
        <div role="presentation" onClick={parentClick} onMouseDown={parentMouseDown}>
          <CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch onDismiss={vi.fn()} />
        </div>,
      )
      fireEvent.mouseDown(screen.getByRole('combobox'))
      fireEvent.click(screen.getByRole('combobox'))
      expect(parentClick).not.toHaveBeenCalled()
      expect(parentMouseDown).not.toHaveBeenCalled()
    })

    it('goes back to a plain "Set priority" once it is no longer a new match', () => {
      const { rerender } = render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch onDismiss={vi.fn()} />)
      rerender(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} onDismiss={vi.fn()} />)
      const select = screen.getByRole('combobox')
      expect(select).toHaveDisplayValue('Set priority')
      expectNotAmber(select)
      expectPlainEmpty(select)
      expect(optionLabels()).not.toContain('Dismiss (reviewed, no priority)')
    })

    it('shows the set priority, not amber, if a priority exists', () => {
      render(<CompactPrioritySelect billId="b1" current="low" onChange={vi.fn()} newMatch onDismiss={vi.fn()} />)
      expect(screen.getByRole('combobox')).toHaveDisplayValue('Low Priority')
      expectNotAmber(screen.getByRole('combobox'))
    })

    it('is amber in the mini size too, as in the sidebar', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch onDismiss={vi.fn()} mini />)
      expectAmber(screen.getByRole('combobox'))
      expect(fontSizeOf(screen.getByRole('combobox'))).toBe('10px')
    })
  })
})
