import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CompactPositionSelect } from './CompactPositionSelect'
import { expectClosedLabel, expectNoClosedLabel } from '../test/closedLabel'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cssVarName } from '../styles/colorModes'

const apiFetchMock = vi.fn()
vi.mock('../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

const OPTIONS = ['Support', 'Oppose', 'Monitor']
const select = () => screen.getByRole('combobox', { name: 'Position' }) as HTMLSelectElement
const optionLabels = () => within(select()).getAllByRole('option', { hidden: true }).map(o => o.textContent)

describe('CompactPositionSelect', () => {
  beforeEach(() => { apiFetchMock.mockReset() })

  describe('an empty position', () => {
    it('reads "Set position" when closed, drawn over the select', () => {
      render(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={vi.fn()} />)
      expectClosedLabel(select(), 'Set position')
    })

    it('lists "Not set" first, then the vocabulary, with no "Set position" entry', () => {
      render(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={vi.fn()} />)
      expect(optionLabels()).toEqual(['Not set', 'Support', 'Oppose', 'Monitor'])
    })

    it('has no placeholder option: nothing is hidden or disabled, and "Not set" is the selected option', () => {
      render(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={vi.fn()} />)
      const all = within(select()).getAllByRole('option', { hidden: true }) as HTMLOptionElement[]
      for (const o of all) { expect(o.disabled).toBe(false); expect(o).not.toHaveAttribute('hidden') }
      expect(select().selectedOptions).toHaveLength(1)
      expect(select().selectedOptions[0].textContent).toBe('Not set')
    })

    it('lets the pointer through the label, and hides it from the accessibility tree', () => {
      render(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={vi.fn()} />)
      const label = select().parentElement!.querySelector('[data-closed-label]') as HTMLElement
      expect(label.style.pointerEvents).toBe('none')
      expect(label).toHaveAttribute('aria-hidden', 'true')
    })

    it('keeps the accessible name "Position" and describes the control with the closed prompt', () => {
      render(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={vi.fn()} />)
      expect(select()).toHaveAccessibleName('Position')
      expect(select()).toHaveAccessibleDescription('Set position')
    })

    it('gives every option its own visible text colour while empty, since the select\'s own text is transparent', () => {
      render(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={vi.fn()} />)
      const options = within(select()).getAllByRole('option', { hidden: true })
      expect(options.length).toBeGreaterThan(0)
      for (const o of options) {
        const style = o.getAttribute('style') ?? ''
        expect(style).toMatch(/(^|;|\s)color: (?!transparent)\S/)
        expect(style).toMatch(/text-fill-color: (?!transparent)\S/)
      }
    })

    it('hides the select\'s own text under the label while empty', () => {
      render(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={vi.fn()} />)
      expect(select().getAttribute('style')).toMatch(/text-fill-color: transparent/)
    })

    it('arrow keys move off "Not set" to the first position, which saves it', async () => {
      apiFetchMock.mockResolvedValue({})
      const onChange = vi.fn()
      render(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={onChange} />)
      const next = select().options[select().selectedIndex + 1]
      expect(next.textContent).toBe('Support')
      fireEvent.change(select(), { target: { value: next.value } })
      await waitFor(() => expect(onChange).toHaveBeenCalledWith('Support'))
      expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/position', { method: 'POST', body: JSON.stringify({ position: 'Support' }) })
    })

    it('choosing "Not set" when there is no position makes no request', async () => {
      const onChange = vi.fn()
      const user = userEvent.setup()
      render(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={onChange} />)
      await user.selectOptions(select(), 'Not set')
      fireEvent.change(select(), { target: { value: '__none__' } })
      await Promise.resolve()
      expect(apiFetchMock).not.toHaveBeenCalled()
      expect(onChange).not.toHaveBeenCalled()
      expectClosedLabel(select(), 'Set position')
    })

    it('lists a vocabulary stance named "No Position" as its own entry, distinct from "Not set"', async () => {
      apiFetchMock.mockResolvedValue({})
      const onChange = vi.fn()
      const user = userEvent.setup()
      render(<CompactPositionSelect billId="b1" current="Support" options={['Support', 'No Position']} onChange={onChange} />)
      expect(optionLabels()).toEqual(['Not set', 'Support', 'No Position'])
      await user.selectOptions(select(), 'No Position')
      await waitFor(() => expect(onChange).toHaveBeenCalledWith('No Position'))
      expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/position', { method: 'POST', body: JSON.stringify({ position: 'No Position' }) })
    })
  })

  describe('a set position', () => {
    it('shows the position, with no label over it and no description', () => {
      render(<CompactPositionSelect billId="b1" current="Oppose" options={OPTIONS} onChange={vi.fn()} />)
      expect(select()).toHaveDisplayValue('Oppose')
      expectNoClosedLabel(select())
      expect(select()).not.toHaveAccessibleDescription()
      expect(select().getAttribute('style')).not.toMatch(/text-fill-color: transparent/)
    })

    it('lists "Not set" first', () => {
      render(<CompactPositionSelect billId="b1" current="Oppose" options={OPTIONS} onChange={vi.fn()} />)
      expect(optionLabels()).toEqual(['Not set', 'Support', 'Oppose', 'Monitor'])
    })

    it('choosing "Not set" sends the DELETE and reports null, then the closed control reads "Set position"', async () => {
      apiFetchMock.mockResolvedValue({})
      const onChange = vi.fn()
      const { rerender } = render(<CompactPositionSelect billId="b1" current="Support" options={OPTIONS} onChange={onChange} />)
      fireEvent.change(select(), { target: { value: '__none__' } })
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(null))
      expect(apiFetchMock).toHaveBeenCalledTimes(1)
      expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/position', { method: 'DELETE' })
      rerender(<CompactPositionSelect billId="b1" current={null} options={OPTIONS} onChange={onChange} />)
      expectClosedLabel(select(), 'Set position')
    })

    it('picking "Not set" by name clears it the same way', async () => {
      apiFetchMock.mockResolvedValue({})
      const onChange = vi.fn()
      const user = userEvent.setup()
      render(<CompactPositionSelect billId="b1" current="Monitor" options={OPTIONS} onChange={onChange} />)
      await user.selectOptions(select(), 'Not set')
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

// jsdom cannot evaluate :focus-visible and does not load mobile.css, so these pin what the browser rule needs: no
// inline outline on the select (an inline style beats the global *:focus-visible ring), and the class and attribute
// the stylesheet's filtered ring keys on, which steps aside while the select has keyboard focus.
describe('CompactPositionSelect: the keyboard focus ring', () => {
  beforeEach(() => { apiFetchMock.mockReset() })
  const mobileCss = readFileSync(resolve(__dirname, '../styles/mobile.css'), 'utf8')
  const expectNoInlineOutline = () => {
    expect(select().style.outline).toBe('')
    expect(select().style.outlineOffset).toBe('')
    expect(select().getAttribute('style')).not.toMatch(/outline/)
  }

  it.each([
    ['empty', { current: null }],
    ['set', { current: 'Support' }],
    ['filtered', { current: 'Support', isFiltered: true }],
  ])('sets no inline outline while %s, on focus or a mouse press', (_state, props) => {
    render(<CompactPositionSelect billId="b1" options={OPTIONS} onChange={vi.fn()} {...props} />)
    expectNoInlineOutline()
    fireEvent.mouseDown(select())
    fireEvent.focus(select())
    expectNoInlineOutline()
  })

  it('marks a filtered select for the stylesheet ring, and only a filtered one', () => {
    const { rerender } = render(<CompactPositionSelect billId="b1" current="Support" options={OPTIONS} onChange={vi.fn()} isFiltered />)
    expect(select()).toHaveClass('fv-chip-select')
    expect(select()).toHaveAttribute('data-filtered')
    rerender(<CompactPositionSelect billId="b1" current="Support" options={OPTIONS} onChange={vi.fn()} />)
    expect(select()).toHaveClass('fv-chip-select')
    expect(select()).not.toHaveAttribute('data-filtered')
  })

  it('draws the filtered ring from the stylesheet only while the select lacks keyboard focus', () => {
    const blue = cssVarName('accentBlue').replace(/-/g, '\\-')
    expect(mobileCss).toMatch(new RegExp(`\\.fv-chip-select\\[data-filtered\\]:not\\(:focus-visible\\)\\s*\\{[^}]*outline:\\s*2px solid var\\(${blue}\\)[^}]*outline-offset:\\s*2px`))
  })
})
