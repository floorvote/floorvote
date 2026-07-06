import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { color } from '../../styles/tokens'
import { DateLabel } from './DateLabel'

describe('DateLabel', () => {
  it('renders the label, muted + uppercase by default', () => {
    render(<DateLabel label="Wednesday, Apr 15" />)
    const el = screen.getByText('Wednesday, Apr 15')
    expect(el).toHaveStyle({ color: color.textMuted, textTransform: 'uppercase' })
  })

  it('uses the amber accent when isToday', () => {
    render(<DateLabel label="Today" isToday />)
    expect(screen.getByText('Today')).toHaveStyle({ color: color.accentAmber })
  })
})
