import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EventForm } from './EventForm'
import type { BillOption } from '../BillPicker'

const opts: BillOption[] = [{ id: '1', billNumber: 'H 100', title: 'Elections', state: 'RI' }]
const pos = { positionStyle: {}, transformOrigin: 'top left', enterOffsetY: -6 }

function setup(props = {}) {
  const onSave = vi.fn()
  render(<EventForm billOptions={opts} multiState onSave={onSave} onClose={vi.fn()} position={pos} {...props} />)
  return { onSave }
}

describe('EventForm', () => {
  it('autofocuses the title field', () => {
    setup()
    expect(document.activeElement === screen.getByLabelText(/title/i)).toBe(true)
  })
  it('warns but allows save for a past date', () => {
    const { onSave } = setup()
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Old meeting' } })
    fireEvent.change(screen.getByLabelText(/date/i), { target: { value: '2000-01-01' } })
    expect(screen.getByText(/in the past/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ date: '2000-01-01', billIds: [] }))
  })
  it('blocks save with no title', () => {
    const { onSave } = setup()
    fireEvent.change(screen.getByLabelText(/date/i), { target: { value: '2999-01-01' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).not.toHaveBeenCalled()
  })
})
