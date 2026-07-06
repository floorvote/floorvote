import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CompactPrioritySelect } from './CompactPrioritySelect'

const apiFetchMock = vi.fn()
vi.mock('../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

describe('CompactPrioritySelect', () => {
  beforeEach(() => apiFetchMock.mockReset())

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
})
