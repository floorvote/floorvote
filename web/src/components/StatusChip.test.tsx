import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StatusChip } from './StatusChip'
import { STATUS_CHIP_MAX_WIDTH } from '../lib/chipStyles'
import { CHIP_GRID, CHIP_GRID_MULTISTATE } from '../pages/BillList/constants'
import { paneGridTemplate } from '../pages/BillList/paneWidth'
import { color } from '../styles/tokens'
import { CHIP_MINI_DIMS } from '../../../shared/billChipColors'
import { LONGEST_STATUS_LABELS, VERY_LONG_STATUS } from './longStatusLabels.fixture'

// The status chip's opt-in width cap (#404): the bill table and the split pane
// pass it; the bill page and any other caller leave it off.

const chipOf = (text: string) => screen.getByText(text)

describe('StatusChip with the cap', () => {
  it('caps the chip at the status column\'s width and ends a long label in an ellipsis', () => {
    render(<StatusChip status={VERY_LONG_STATUS} capWidth />)
    const chip = chipOf(VERY_LONG_STATUS)
    expect(chip.style.maxWidth).toBe('100px')
    expect(chip.style.overflow).toBe('hidden')
    expect(chip.style.textOverflow).toBe('ellipsis')
    expect(chip.style.whiteSpace).toBe('nowrap')
  })

  it('keeps the cap inside the chip box, padding and border included', () => {
    render(<StatusChip status={VERY_LONG_STATUS} capWidth />)
    expect(chipOf(VERY_LONG_STATUS).style.boxSizing).toBe('border-box')
  })

  it('shows the full label as hover text', () => {
    render(<StatusChip status={VERY_LONG_STATUS} capWidth />)
    expect(chipOf(VERY_LONG_STATUS)).toHaveAttribute('title', VERY_LONG_STATUS)
  })

  it('keeps the whole label in the markup, so a screen reader reads it in full', () => {
    const { container } = render(<StatusChip status={VERY_LONG_STATUS} capWidth />)
    expect(container).toHaveTextContent(VERY_LONG_STATUS)
  })

  it('does not use the ⓘ button for the full label: the chip stays plain text', () => {
    const { container } = render(<StatusChip status={VERY_LONG_STATUS} capWidth />)
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).toBe(VERY_LONG_STATUS)
  })

  it('stays a button named by the full label, with the hover text, when it filters', () => {
    const onClick = vi.fn()
    render(<StatusChip status={VERY_LONG_STATUS} capWidth onClick={onClick} />)
    const button = screen.getByRole('button', { name: VERY_LONG_STATUS })
    expect(button).toHaveAttribute('title', VERY_LONG_STATUS)
    expect(chipOf(VERY_LONG_STATUS).style.maxWidth).toBe('100px')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('lets the button shrink to the cap rather than stretch past it', () => {
    render(<StatusChip status={VERY_LONG_STATUS} capWidth onClick={() => {}} />)
    const button = screen.getByRole('button', { name: VERY_LONG_STATUS })
    expect(button.style.maxWidth).toBe('100px')
    expect(button.style.minWidth).toBe('0px')
  })

  it('keeps the pointer to the longer explanation', () => {
    render(<StatusChip status={VERY_LONG_STATUS} capWidth describedBy="why" />)
    expect(chipOf(VERY_LONG_STATUS)).toHaveAttribute('aria-describedby', 'why')
  })

  it('keeps the chip fill, text color, and outline from the shared chip styles', () => {
    render(<StatusChip status={VERY_LONG_STATUS} capWidth isActive onClick={() => {}} />)
    const chip = chipOf(VERY_LONG_STATUS)
    expect(chip.style.background).toBe(color.countChipBg)
    expect(chip.style.color).toBe(color.textSecondary)
    expect(chip.style.fontWeight).toBe('600')
  })

  it('draws nothing for an empty status', () => {
    const { container } = render(<StatusChip status={null} capWidth />)
    expect(container).toBeEmptyDOMElement()
  })

  describe.each(LONGEST_STATUS_LABELS)('the longest $provider label', ({ label }) => {
    it('is capped, ends in an ellipsis, and carries its full name', () => {
      render(<StatusChip status={label} capWidth />)
      const chip = chipOf(label)
      expect(chip.style.maxWidth).toBe('100px')
      expect(chip.style.textOverflow).toBe('ellipsis')
      expect(chip).toHaveAttribute('title', label)
      expect(chip.textContent).toBe(label)
    })
  })
})

describe('StatusChip without the cap', () => {
  it('shows a long label in full, with no cap, ellipsis, or hover text', () => {
    render(<StatusChip status={VERY_LONG_STATUS} />)
    const chip = chipOf(VERY_LONG_STATUS)
    expect(chip.style.maxWidth).toBe('')
    expect(chip.style.overflow).toBe('')
    expect(chip.style.textOverflow).toBe('')
    expect(chip).not.toHaveAttribute('title')
    expect(chip.style.whiteSpace).toBe('nowrap')
  })

  it('is the same with capWidth={false}', () => {
    const a = render(<StatusChip status={VERY_LONG_STATUS} />)
    const before = a.container.innerHTML
    a.unmount()
    const b = render(<StatusChip status={VERY_LONG_STATUS} capWidth={false} />)
    expect(b.container.innerHTML).toBe(before)
  })

  it('leaves the filter button uncapped too', () => {
    render(<StatusChip status={VERY_LONG_STATUS} onClick={() => {}} />)
    const button = screen.getByRole('button', { name: VERY_LONG_STATUS })
    expect(button.style.maxWidth).toBe('')
    expect(button).not.toHaveAttribute('title')
  })

  it.each(LONGEST_STATUS_LABELS)('shows the longest $provider label whole', ({ label }) => {
    render(<StatusChip status={label} />)
    expect(chipOf(label).style.maxWidth).toBe('')
  })
})

describe('a short label', () => {
  it('reads the same capped: same text, and the cap is a ceiling, not a width', () => {
    render(<StatusChip status="Passed" capWidth />)
    const chip = chipOf('Passed')
    expect(chip.textContent).toBe('Passed')
    // Fits well inside the cap, so nothing is cut: the cap is a ceiling, not a width.
    expect(chip.style.width).toBe('')
    expect(chip.style.minWidth).toBe('')
  })

  it('is untouched uncapped: no title, no cap', () => {
    render(<StatusChip status="Passed" />)
    const chip = chipOf('Passed')
    expect(chip).not.toHaveAttribute('title')
    expect(chip.style.maxWidth).toBe('')
    expect(chip.style.textOverflow).toBe('')
  })
})

describe('StatusChip mini', () => {
  it('is smaller than the default chip, in the shared mini dimensions', () => {
    const { rerender } = render(<StatusChip status="Passed" />)
    const full = chipOf('Passed')
    const fullSize = parseFloat(full.style.fontSize)
    rerender(<StatusChip status="Passed" mini />)
    const mini = chipOf('Passed')
    expect(parseFloat(mini.style.fontSize)).toBeLessThan(fullSize)
    expect(mini.style.fontSize).toBe(`${CHIP_MINI_DIMS.fontSize}px`)
    expect(mini.style.padding).toBe(CHIP_MINI_DIMS.padding)
  })

  it('keeps the default chip as it was without the prop', () => {
    render(<StatusChip status="Passed" />)
    expect(chipOf('Passed').style.padding).toBe('3px 10px')
  })

  it('stays plain text with no click handler, and a button with one', () => {
    const { rerender } = render(<StatusChip status="Passed" mini />)
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<StatusChip status="Passed" mini onClick={() => {}} />)
    expect(screen.getByRole('button', { name: 'Passed' })).toBeInTheDocument()
  })

  it('renders nothing for an empty status', () => {
    const { container } = render(<StatusChip status="" mini />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('the cap value', () => {
  it('is 100', () => {
    expect(STATUS_CHIP_MAX_WIDTH).toBe(100)
  })

  it('matches the Bills page\'s status track, single- and multi-state', () => {
    expect(CHIP_GRID.split(' ')[1]).toBe(`${STATUS_CHIP_MAX_WIDTH}px`)
    expect(CHIP_GRID_MULTISTATE.split(' ')[1]).toBe(`${STATUS_CHIP_MAX_WIDTH}px`)
  })

  it('matches the split pane\'s status track', () => {
    const template = paneGridTemplate([{ key: 'status', label: 'Status', at: 400 }], false)
    expect(template.split(' ')[1]).toBe(`${STATUS_CHIP_MAX_WIDTH}px`)
  })
})
