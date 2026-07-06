import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NewMatchTriageControl } from './NewMatchTriageControl'

const apiFetchMock = vi.fn()
vi.mock('../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

describe('NewMatchTriageControl', () => {
  beforeEach(() => apiFetchMock.mockReset())

  it('renders the priority select and a Dismiss control', () => {
    render(<NewMatchTriageControl billId="b1" current={null} onChange={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByRole('combobox')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument()
  })

  it('dismiss calls the triage-dismiss endpoint then onDismiss', async () => {
    apiFetchMock.mockResolvedValue({ ok: true })
    const onDismiss = vi.fn()
    render(<NewMatchTriageControl billId="b1" current={null} onChange={vi.fn()} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => expect(onDismiss).toHaveBeenCalled())
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/triage-dismiss', { method: 'PATCH' })
  })

  it('forwards priority selection through onChange', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'high' })
    const onChange = vi.fn()
    render(<NewMatchTriageControl billId="b1" current={null} onChange={onChange} onDismiss={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'high' } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('high', expect.anything()))
  })
})
