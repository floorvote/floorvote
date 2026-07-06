import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InfoTooltip } from './InfoTooltip'

describe('InfoTooltip', () => {
  it('renders the info glyph and reveals its text on hover', () => {
    render(<InfoTooltip text="Helpful detail" />)
    expect(screen.getByText('info')).toBeInTheDocument()
    expect(screen.queryByText('Helpful detail')).toBeNull()
    fireEvent.pointerEnter(screen.getByText('info').parentElement!, { pointerType: 'mouse' })
    expect(screen.getByText('Helpful detail')).toBeInTheDocument()
  })
})
