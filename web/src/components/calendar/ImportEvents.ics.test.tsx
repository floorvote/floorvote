import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'

const { demo } = vi.hoisted(() => ({ demo: { demoMode: false, demoLocked: false } }))
vi.mock('../../context/DemoContext', () => ({ useDemo: () => demo }))
vi.mock('../../lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue({ created: 1, updated: 0, unchanged: 0, skipped: 0 }) }))

import { ImportEvents } from './ImportEvents'
import { apiFetch } from '../../lib/api'

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:evt-1@outlook', 'SUMMARY:Registration deadline',
  'DTSTART;VALUE=DATE:20260504', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n')

describe('ImportEvents — .ics', () => {
  beforeEach(() => { demo.demoLocked = false; vi.clearAllMocks() })

  it('previews an uploaded .ics and posts its uid through to the API', async () => {
    const user = userEvent.setup()
    render(<ImportEvents onClose={() => {}} onImported={() => {}} />)

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, new File([ICS], 'deadlines.ics', { type: 'text/calendar' }))

    await waitFor(() => expect(screen.getByDisplayValue('Registration deadline')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /create|import/i }))

    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    const body = JSON.parse((vi.mocked(apiFetch).mock.calls[0][1] as RequestInit).body as string)
    expect(body.rows[0]).toMatchObject({ title: 'Registration deadline', date: '2026-05-04', uid: 'evt-1@outlook' })
  })
})
