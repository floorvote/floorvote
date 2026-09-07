import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SearchClearButton } from './SearchClearButton'

describe('SearchClearButton', () => {
  it('has an accessible name, being icon-only', () => {
    render(<SearchClearButton onClear={vi.fn()} />)
    expect(screen.getByRole('button', { name: /clear search/i })).toBeInTheDocument()
  })

  it('calls onClear when clicked', () => {
    const onClear = vi.fn()
    render(<SearchClearButton onClear={onClear} />)
    fireEvent.click(screen.getByRole('button', { name: /clear search/i }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
