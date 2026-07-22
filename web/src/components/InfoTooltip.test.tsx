import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InfoTooltip } from './InfoTooltip'

describe('InfoTooltip', () => {
  it('renders the info glyph and reveals its text on hover', () => {
    render(<InfoTooltip text="Helpful detail" />)
    expect(screen.getByText('info')).toBeInTheDocument()
    expect(screen.queryByText('Helpful detail')).toBeNull()
    fireEvent.pointerEnter(screen.getByRole('button'), { pointerType: 'mouse' })
    expect(screen.getByText('Helpful detail')).toBeInTheDocument()
  })

  it('renders the trigger as a real button with an accessible name', () => {
    render(<InfoTooltip text="Helpful detail" />)
    const trigger = screen.getByRole('button', { name: 'More information' })
    expect(trigger.tagName.toLowerCase()).toBe('button')
  })

  it('accepts a custom label for the accessible name', () => {
    render(<InfoTooltip text="Helpful detail" label="About this score" />)
    expect(screen.getByRole('button', { name: 'About this score' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More information' })).toBeNull()
  })

  it('hides the icon glyph from the accessible name so only the label is announced', () => {
    render(<InfoTooltip text="Helpful detail" />)
    expect(screen.getByText('info').getAttribute('aria-hidden')).toBe('true')
  })

  it('reveals the tooltip on tap/click, links it via aria-describedby, and toggles closed on a second click', async () => {
    const user = userEvent.setup()
    render(<InfoTooltip text="Helpful detail" />)
    const trigger = screen.getByRole('button')
    expect(screen.queryByRole('tooltip')).toBeNull()

    await user.click(trigger)
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Helpful detail')
    expect(trigger.getAttribute('aria-describedby')).toBe(tip.id)

    await user.click(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('hides the tooltip on Escape', async () => {
    const user = userEvent.setup()
    render(<InfoTooltip text="Helpful detail" />)
    await user.click(screen.getByRole('button'))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('reveals the tooltip on keyboard focus, preserving the original text', async () => {
    const user = userEvent.setup()
    render(<InfoTooltip text="Helpful detail" />)
    await user.tab()
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Helpful detail')
  })
})
