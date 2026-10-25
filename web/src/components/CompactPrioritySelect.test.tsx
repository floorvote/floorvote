import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CompactPrioritySelect } from './CompactPrioritySelect'
import { expectAmber, expectNotAmber, expectPlainEmpty, fontSizeOf } from '../test/amberStyle'
import { expectClosedLabel, expectNoClosedLabel, closedLabelOf } from '../test/closedLabel'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cssVarName } from '../styles/colorModes'

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
    it('reads "Set priority", not "Not set", when closed', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
      expectClosedLabel(screen.getByRole('combobox'), 'Set priority')
      expect(screen.queryByText('Not set')).toBeNull()
    })

    it('lists "No priority" first, then the three priorities, with no "Set priority" entry and no Dismiss', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
      expect(optionLabels()).toEqual(['No priority', 'High Priority', 'Medium Priority', 'Low Priority'])
      expect(optionLabels()).not.toContain('Set priority')
    })

    it('has no placeholder option: nothing in the menu is hidden or disabled, and the empty choice is the selected one', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
      const select = screen.getByRole('combobox') as HTMLSelectElement
      // hidden: true so a hidden placeholder would show up here if there were one.
      const all = within(select).getAllByRole('option', { hidden: true }) as HTMLOptionElement[]
      expect(all.map(o => o.textContent)).toEqual(['No priority', 'High Priority', 'Medium Priority', 'Low Priority'])
      for (const o of all) { expect(o.disabled).toBe(false); expect(o).not.toHaveAttribute('hidden') }
      expect(select.selectedOptions).toHaveLength(1)
      expect(select.selectedOptions[0].textContent).toBe('No priority')
      expect(select.value).toBe('__none__')
    })

    it('draws "Set priority" over the select as a label the pointer passes through, and gives the select the name "Priority"', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
      const select = screen.getByRole('combobox', { name: 'Priority' })
      expectClosedLabel(select, 'Set priority')
      const label = select.parentElement!.querySelector('[data-closed-label]') as HTMLElement
      expect(label.style.visibility).not.toBe('hidden')
      expect(label.style.pointerEvents).toBe('none')
      expect(label).toHaveAttribute('aria-hidden', 'true')
    })

    it('makes the closed prompt available to assistive tech as the control\'s description', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
      expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveAccessibleDescription('Set priority')
    })

    it('makes the amber prompt the description of an amber control', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch onDismiss={vi.fn()} />)
      expect(screen.getByRole('combobox')).toHaveAccessibleDescription('New · Set priority')
    })

    it('has no description and no layered label once a priority is set', () => {
      render(<CompactPrioritySelect billId="b1" current="high" onChange={vi.fn()} />)
      const select = screen.getByRole('combobox')
      expectNoClosedLabel(select)
      expect(select).not.toHaveAccessibleDescription()
    })

    it('gives every option its own visible text colour while empty, since the select\'s own text is transparent', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch onDismiss={vi.fn()} />)
      const options = within(screen.getByRole('combobox')).getAllByRole('option', { hidden: true })
      expect(options.length).toBeGreaterThan(0)
      for (const o of options) {
        const style = o.getAttribute('style') ?? ''
        expect(style).toMatch(/(^|;|\s)color: (?!transparent)\S/)
        expect(style).toMatch(/text-fill-color: (?!transparent)\S/)
      }
    })

    it('hides the select\'s own text under the label while empty, and keeps its text colour token for the menu', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
      expect(screen.getByRole('combobox').getAttribute('style')).toMatch(/text-fill-color: transparent/)
    })

    it('shows the select\'s own text once a priority is set', () => {
      render(<CompactPrioritySelect billId="b1" current="low" onChange={vi.fn()} />)
      expect(screen.getByRole('combobox').getAttribute('style')).not.toMatch(/text-fill-color: transparent/)
    })

    it('arrow keys move off the empty choice to High: the option after "No priority" is High, and choosing it saves', async () => {
      apiFetchMock.mockResolvedValue({ priority: 'high' })
      const onChange = vi.fn()
      render(<CompactPrioritySelect billId="b1" current={null} onChange={onChange} />)
      const select = screen.getByRole('combobox') as HTMLSelectElement
      // ArrowDown on a closed select selects the next option, so the first stop must be a real choice.
      const next = select.options[select.selectedIndex + 1]
      expect(next.textContent).toBe('High Priority')
      fireEvent.change(select, { target: { value: next.value } })
      await waitFor(() => expect(onChange).toHaveBeenCalledWith('high', expect.anything()))
      expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/priority', { method: 'PATCH', body: JSON.stringify({ priority: 'high' }) })
    })

    it('ArrowUp from High returns to "No priority", which clears', async () => {
      apiFetchMock.mockResolvedValue({ priority: null })
      const onChange = vi.fn()
      render(<CompactPrioritySelect billId="b1" current="high" onChange={onChange} />)
      const select = screen.getByRole('combobox') as HTMLSelectElement
      const prev = select.options[select.selectedIndex - 1]
      expect(prev.textContent).toBe('No priority')
      fireEvent.change(select, { target: { value: prev.value } })
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(null, expect.anything()))
    })

    it('choosing "No priority" when there is no priority makes no request and calls nothing', async () => {
      const onChange = vi.fn()
      render(<CompactPrioritySelect billId="b1" current={null} onChange={onChange} />)
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '__none__' } })
      await Promise.resolve()
      expect(apiFetchMock).not.toHaveBeenCalled()
      expect(onChange).not.toHaveBeenCalled()
      expectClosedLabel(screen.getByRole('combobox'), 'Set priority')
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('picking "No priority" by name on an empty priority also makes no request', async () => {
      const user = userEvent.setup()
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
      await user.selectOptions(screen.getByRole('combobox'), 'No priority')
      expect(apiFetchMock).not.toHaveBeenCalled()
      expectClosedLabel(screen.getByRole('combobox'), 'Set priority')
    })

    it('stays white with a default border, not amber', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
      expectPlainEmpty(screen.getByRole('combobox'))
    })

    it('still honors a caller-supplied closed label, and the menu still says "No priority"', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} placeholder="Pick one" />)
      expectClosedLabel(screen.getByRole('combobox'), 'Pick one')
      expect(optionLabels()).toEqual(['No priority', 'High Priority', 'Medium Priority', 'Low Priority'])
    })

    it('in the mini size reads "Set priority" closed and lists "No priority" in the menu', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} mini />)
      expectClosedLabel(screen.getByRole('combobox'), 'Set priority')
      expect(optionLabels()).toEqual(['No priority', 'High Priority', 'Medium Priority', 'Low Priority'])
    })
  })

  describe('a set priority', () => {
    it('shows the priority and has no Dismiss option', () => {
      render(<CompactPrioritySelect billId="b1" current="medium" onChange={vi.fn()} />)
      expect(screen.getByRole('combobox')).toHaveDisplayValue('Medium Priority')
      expect(optionLabels()).toEqual(['No priority', 'High Priority', 'Medium Priority', 'Low Priority'])
    })

    it('choosing "No priority" clears the priority with a null PATCH, and the closed control then reads "Set priority"', async () => {
      apiFetchMock.mockResolvedValue({ priority: null })
      const onChange = vi.fn()
      const { rerender } = render(<CompactPrioritySelect billId="b1" current="high" onChange={onChange} />)
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '__none__' } })
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(null, expect.anything()))
      expect(apiFetchMock).toHaveBeenCalledTimes(1)
      expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/priority', { method: 'PATCH', body: JSON.stringify({ priority: null }) })
      rerender(<CompactPrioritySelect billId="b1" current={null} onChange={onChange} />)
      expectClosedLabel(screen.getByRole('combobox'), 'Set priority')
    })

    it('picking "No priority" by name clears it the same way', async () => {
      apiFetchMock.mockResolvedValue({ priority: null })
      const onChange = vi.fn()
      const user = userEvent.setup()
      render(<CompactPrioritySelect billId="b1" current="low" onChange={onChange} />)
      await user.selectOptions(screen.getByRole('combobox'), 'No priority')
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(null, expect.anything()))
    })

    it('has a single "High Priority" option while High is set (no duplicate hidden option)', () => {
      render(<CompactPrioritySelect billId="b1" current="high" onChange={vi.fn()} />)
      expect(within(screen.getByRole('combobox')).getAllByText('High Priority')).toHaveLength(1)
    })

    it('shows the priority, not the closed label, while one is set', () => {
      render(<CompactPrioritySelect billId="b1" current="high" onChange={vi.fn()} />)
      const select = screen.getByRole('combobox') as HTMLSelectElement
      expect(select.selectedOptions[0].textContent).toBe('High Priority')
      expect(optionLabels()).not.toContain('Set priority')
      expectNoClosedLabel(select)
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
      expectClosedLabel(screen.getByRole('combobox'), 'New · Set priority')
    })

    it('is amber: the amber fill, dark amber text, and amber border', () => {
      renderNew()
      expectAmber(screen.getByRole('combobox'))
    })

    it('lists the priorities, then Dismiss as the last option', () => {
      renderNew()
      expect(optionLabels()).toEqual([
        'No priority', 'High Priority', 'Medium Priority', 'Low Priority', 'Dismiss (reviewed, no priority)',
      ])
      expect(optionLabels()).not.toContain('New · Set priority')
    })

    it('draws "New · Set priority" over the amber select, which sits on "No priority" with no hidden option', () => {
      renderNew()
      const select = screen.getByRole('combobox') as HTMLSelectElement
      expectClosedLabel(select, 'New · Set priority')
      expect(select.selectedOptions[0].textContent).toBe('No priority')
      const all = within(select).getAllByRole('option', { hidden: true }) as HTMLOptionElement[]
      for (const o of all) { expect(o.disabled).toBe(false); expect(o).not.toHaveAttribute('hidden') }
    })

    it('choosing "No priority" on a new match makes no request and stays a new match', async () => {
      const { onChange, onDismiss } = renderNew()
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '__none__' } })
      await Promise.resolve()
      expect(apiFetchMock).not.toHaveBeenCalled()
      expect(onChange).not.toHaveBeenCalled()
      expect(onDismiss).not.toHaveBeenCalled()
      expectClosedLabel(screen.getByRole('combobox'), 'New · Set priority')
      expectAmber(screen.getByRole('combobox'))
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

    it('reports a failed Dismiss as an alert and leaves the control a new match', async () => {
      apiFetchMock.mockRejectedValue(new Error('boom'))
      const { onDismiss } = renderNew()
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dismiss' } })
      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't dismiss. Try again.")
      expect(onDismiss).not.toHaveBeenCalled()
      expectClosedLabel(screen.getByRole('combobox'), 'New · Set priority')
      expectAmber(screen.getByRole('combobox'))
    })

    it('clears the error when the next Dismiss succeeds', async () => {
      apiFetchMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ ok: true })
      const { onDismiss } = renderNew()
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dismiss' } })
      await screen.findByRole('alert')
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dismiss' } })
      await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1))
      expect(screen.queryByRole('alert')).toBeNull()
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
      expectClosedLabel(select, 'Set priority')
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

    it('reads "New · Set priority" closed and lists "No priority" first in the mini size', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch onDismiss={vi.fn()} mini />)
      expectClosedLabel(screen.getByRole('combobox'), 'New · Set priority')
      expect(optionLabels()).toEqual(['No priority', 'High Priority', 'Medium Priority', 'Low Priority', 'Dismiss (reviewed, no priority)'])
    })
  })

  // The native <select> is as wide as its widest option, so "Dismiss (reviewed, no priority)" stretched the closed
  // new-match chip past the bill table's priority column. The closed control sizes to its own text instead: a hidden
  // copy of the selected label sets the width, and the select fills it. jsdom has no layout, so these assert the
  // sizing contract through style.
  describe('the closed control sizes to its own text', () => {
    const sizer = () => screen.getByTestId('priority-select-sizer')
    const selectEl = () => screen.getByRole('combobox')

    it('sizes the new-match chip by "New · Set priority", not by the longest option', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch onDismiss={vi.fn()} />)
      expect(sizer()).toHaveTextContent(/^New · Set priority$/)
      expect(sizer().textContent).not.toMatch(/Dismiss/)
    })

    it('lets the select fill that width instead of asking for its widest option', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch onDismiss={vi.fn()} />)
      expect(selectEl().style.width).toMatch(/^0(px)?$/)
      expect(selectEl().style.minWidth).toBe('100%')
      expect(selectEl().parentElement!.style.display).toBe('inline-grid')
      expect(sizer().parentElement).toBe(selectEl().parentElement)
    })

    it('copies the select\'s font and padding onto the sizer, so the two measure alike', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch onDismiss={vi.fn()} />)
      for (const prop of ['fontSize', 'fontWeight', 'fontFamily', 'padding'] as const) {
        expect(sizer().style[prop]).toBe(selectEl().style[prop])
      }
      expect(sizer().style.border).toMatch(/1px solid/)
    })

    it('does the same in the mini size', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch onDismiss={vi.fn()} mini />)
      expect(sizer().style.padding).toBe(selectEl().style.padding)
      expect(sizer().style.fontSize).toBe('10px')
    })

    it('shows the sizer as the closed label while empty and hides it behind the select\'s own text once a priority is set', () => {
      const { rerender } = render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
      expect(sizer().style.visibility).not.toBe('hidden')
      expect(sizer()).toHaveAttribute('data-closed-label')
      rerender(<CompactPrioritySelect billId="b1" current="low" onChange={vi.fn()} />)
      expect(sizer().style.visibility).toBe('hidden')
      expect(sizer()).not.toHaveAttribute('data-closed-label')
    })

    it('tracks the selected label: a set priority, a plain empty one, and a custom placeholder', () => {
      const { rerender } = render(<CompactPrioritySelect billId="b1" current="medium" onChange={vi.fn()} newMatch onDismiss={vi.fn()} />)
      expect(sizer()).toHaveTextContent(/^Medium Priority$/)
      rerender(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
      expect(sizer()).toHaveTextContent(/^Set priority$/)
      rerender(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} placeholder="Pick one" />)
      expect(sizer()).toHaveTextContent(/^Pick one$/)
      rerender(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch onDismiss={vi.fn()} />)
      expect(sizer()).toHaveTextContent(/^New · Set priority$/)
    })

    it('sizes by the closed label, never by the menu-only "No priority"', () => {
      const { rerender } = render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
      expect(sizer()).toHaveTextContent(/^Set priority$/)
      expect(sizer().textContent).not.toMatch(/No priority/)
      expect(closedLabelOf(selectEl())).toBe('Set priority')
      rerender(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} mini />)
      expect(sizer().textContent).toBe(closedLabelOf(selectEl()))
    })

    it('keeps the sizer out of the accessibility tree, and the select\'s accessible name and options intact', () => {
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch onDismiss={vi.fn()} />)
      expect(sizer()).toHaveAttribute('aria-hidden', 'true')
      expect(screen.queryByText('New · Set priority', { selector: '[aria-hidden="true"]' })).not.toBeNull()
      expect(screen.getByRole('combobox', { name: 'Priority (new match: set a priority or dismiss)' })).toBeInTheDocument()
      expect(optionLabels()).toContain('Dismiss (reviewed, no priority)')
    })

    it('leaves clicks to the select: the sizer cannot be hit, empty or not', () => {
      const { rerender } = render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch onDismiss={vi.fn()} />)
      expect(sizer().style.pointerEvents).toBe('none')
      rerender(<CompactPrioritySelect billId="b1" current="high" onChange={vi.fn()} />)
      expect(sizer().style.pointerEvents).toBe('none')
    })
  })
})

describe('CompactPrioritySelect: a failed priority save', () => {
  beforeEach(() => { apiFetchMock.mockReset() })
  const select = () => screen.getByRole('combobox')

  it('says so in an alert, does not call onChange, and stays on the saved priority', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'))
    const onChange = vi.fn()
    render(<CompactPrioritySelect billId="b1" current="low" onChange={onChange} />)
    fireEvent.change(select(), { target: { value: 'high' } })
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save priority. Try again.")
    expect(onChange).not.toHaveBeenCalled()
    expect(select()).toHaveValue('low')
  })

  it('says so for a failed clear, too', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'))
    const onChange = vi.fn()
    render(<CompactPrioritySelect billId="b1" current="low" onChange={onChange} />)
    fireEvent.change(select(), { target: { value: '__none__' } })
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save priority. Try again.")
    expect(onChange).not.toHaveBeenCalled()
    expect(select()).toHaveValue('low')
  })

  it('says so in the mini variant', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'))
    render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} mini />)
    fireEvent.change(select(), { target: { value: 'medium' } })
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save priority. Try again.")
  })

  it('clears the message when the next save succeeds', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ priority: 'high' })
    const onChange = vi.fn()
    render(<CompactPrioritySelect billId="b1" current={null} onChange={onChange} />)
    fireEvent.change(select(), { target: { value: 'high' } })
    await screen.findByRole('alert')
    fireEvent.change(select(), { target: { value: 'high' } })
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('clears the message as soon as the next change starts', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('boom')).mockReturnValueOnce(new Promise(() => {}))
    render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
    fireEvent.change(select(), { target: { value: 'high' } })
    await screen.findByRole('alert')
    fireEvent.change(select(), { target: { value: 'low' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows one message at a time: a failed Dismiss then a failed save reads as the save', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'))
    render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch onDismiss={vi.fn()} />)
    fireEvent.change(select(), { target: { value: 'dismiss' } })
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't dismiss. Try again.")
    fireEvent.change(select(), { target: { value: 'high' } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't save priority. Try again."))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  // The alert is wider than the control, which sits at the right edge of a card or the sidebar, so
  // it can grow leftward there instead of running past an overflow-hidden edge.
  it('hangs the alert from the control\'s left edge by default', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'))
    render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
    fireEvent.change(select(), { target: { value: 'high' } })
    const alert = await screen.findByRole('alert')
    expect(alert.style.left).toBe('0px')
    expect(alert.style.right).toBe('')
  })

  it('hangs the alert from the control\'s right edge when asked, for a control at a container\'s right edge', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'))
    render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} errorAlign="right" />)
    fireEvent.change(select(), { target: { value: 'high' } })
    const alert = await screen.findByRole('alert')
    expect(alert.style.right).toBe('0px')
    expect(alert.style.left).toBe('')
  })

  it('aligns a failed Dismiss the same way', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'))
    render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch onDismiss={vi.fn()} errorAlign="right" />)
    fireEvent.change(select(), { target: { value: 'dismiss' } })
    expect((await screen.findByRole('alert')).style.right).toBe('0px')
  })

  describe('a slow earlier save that settles after a later one', () => {
    const deferred = () => {
      let resolve!: (v: unknown) => void
      let reject!: (e: unknown) => void
      const promise = new Promise((res, rej) => { resolve = res; reject = rej })
      return { promise, resolve, reject }
    }

    it('shows no error when the earlier save fails after the later one succeeded, and keeps the later value', async () => {
      const a = deferred()
      apiFetchMock.mockReturnValueOnce(a.promise).mockResolvedValueOnce({ priority: 'low' })
      const onChange = vi.fn()
      const { rerender } = render(<CompactPrioritySelect billId="b1" current={null} onChange={onChange} />)
      fireEvent.change(select(), { target: { value: 'high' } })   // A, slow
      fireEvent.change(select(), { target: { value: 'low' } })    // B
      await waitFor(() => expect(onChange).toHaveBeenCalledWith('low', { priority: 'low' }))
      rerender(<CompactPrioritySelect billId="b1" current="low" onChange={onChange} />)
      a.reject(new Error('timeout'))
      await new Promise(r => setTimeout(r, 20))
      expect(screen.queryByRole('alert')).toBeNull()
      expect(select()).toHaveValue('low')
      expect(onChange).toHaveBeenCalledTimes(1)
    })

    it('does not report the earlier save when it succeeds after the later one did', async () => {
      const a = deferred()
      apiFetchMock.mockReturnValueOnce(a.promise).mockResolvedValueOnce({ priority: 'low' })
      const onChange = vi.fn()
      render(<CompactPrioritySelect billId="b1" current={null} onChange={onChange} />)
      fireEvent.change(select(), { target: { value: 'high' } })
      fireEvent.change(select(), { target: { value: 'low' } })
      await waitFor(() => expect(onChange).toHaveBeenCalledWith('low', { priority: 'low' }))
      a.resolve({ priority: 'high' })
      await new Promise(r => setTimeout(r, 20))
      expect(onChange).toHaveBeenCalledTimes(1)
    })

    it('still shows the error when the latest save is the one that fails', async () => {
      const a = deferred()
      const b = deferred()
      apiFetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
      render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
      fireEvent.change(select(), { target: { value: 'high' } })
      fireEvent.change(select(), { target: { value: 'low' } })
      b.reject(new Error('boom'))
      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save priority. Try again.")
    })
  })
})

describe('CompactPrioritySelect: an accessible name from its caller', () => {
  it('uses the name it is given, in place of "Priority", for either state', () => {
    const { rerender } = render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} ariaLabel="Priority for HB 1" />)
    expect(screen.getByRole('combobox', { name: 'Priority for HB 1' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Priority' })).toBeNull()
    rerender(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch ariaLabel="Priority for HB 1 (new match)" />)
    expect(screen.getByRole('combobox', { name: 'Priority for HB 1 (new match)' })).toBeInTheDocument()
  })

  it('keeps "Priority", and the new-match name, when it is given none', () => {
    const { rerender } = render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: 'Priority' })).toBeInTheDocument()
    rerender(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} newMatch />)
    expect(screen.getByRole('combobox', { name: 'Priority (new match: set a priority or dismiss)' })).toBeInTheDocument()
  })
})

// jsdom cannot evaluate :focus-visible and does not load mobile.css, so these pin what the browser rule needs: no
// inline outline on the select in any state (an inline style beats the global *:focus-visible ring), and the class
// and attribute the stylesheet's filtered ring keys on, which steps aside while the select has keyboard focus.
describe('CompactPrioritySelect: the keyboard focus ring', () => {
  beforeEach(() => { apiFetchMock.mockReset() })
  const mobileCss = readFileSync(resolve(__dirname, '../styles/mobile.css'), 'utf8')
  const selectEl = () => screen.getByRole('combobox') as HTMLSelectElement
  const expectNoInlineOutline = () => {
    expect(selectEl().style.outline).toBe('')
    expect(selectEl().style.outlineOffset).toBe('')
    expect(selectEl().getAttribute('style')).not.toMatch(/outline/)
  }

  it.each([
    ['empty', {}],
    ['set', { current: 'high' as const }],
    ['an amber new match', { newMatch: true, onDismiss: vi.fn() }],
    ['the mini (sidebar) size', { mini: true }],
    ['an amber new match in the mini size', { newMatch: true, onDismiss: vi.fn(), mini: true }],
    ['filtered', { current: 'medium' as const, isFiltered: true }],
  ])('sets no inline outline while %s, on focus or a mouse press', (_state, props) => {
    render(<CompactPrioritySelect billId="b1" current={null} onChange={vi.fn()} {...props} />)
    expectNoInlineOutline()
    fireEvent.mouseDown(selectEl())
    fireEvent.focus(selectEl())
    expectNoInlineOutline()
  })

  it('marks a filtered select for the stylesheet ring, and only a filtered one', () => {
    const { rerender } = render(<CompactPrioritySelect billId="b1" current="high" onChange={vi.fn()} isFiltered />)
    expect(selectEl()).toHaveClass('fv-chip-select')
    expect(selectEl()).toHaveAttribute('data-filtered')
    rerender(<CompactPrioritySelect billId="b1" current="high" onChange={vi.fn()} />)
    expect(selectEl()).toHaveClass('fv-chip-select')
    expect(selectEl()).not.toHaveAttribute('data-filtered')
  })

  it('draws the filtered ring from the stylesheet only while the select lacks keyboard focus', () => {
    const blue = cssVarName('accentBlue').replace(/-/g, '\\-')
    expect(mobileCss).toMatch(new RegExp(`\\.fv-chip-select\\[data-filtered\\]:not\\(:focus-visible\\)\\s*\\{[^}]*outline:\\s*2px solid var\\(${blue}\\)[^}]*outline-offset:\\s*2px`))
  })

  it('leaves keyboard focus to the global ring, which a mouse click does not draw', () => {
    expect(mobileCss).toMatch(/\*:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--fv-focus-ring\)/)
    expect(mobileCss).toMatch(/\*:focus:not\(:focus-visible\)\s*\{\s*outline:\s*none/)
  })
})
