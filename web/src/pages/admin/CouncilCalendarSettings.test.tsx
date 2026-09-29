import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiFetch } from '../../lib/api'
import { CouncilCalendarSettings } from './CouncilCalendarSettings'

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message) }
  },
}))

const LOADED = {
  rules: { include: [{ committee: 'Youth Affairs' }, { committee: 'Committee of the Whole', type: 'Meeting' }], types: [], topicKeywords: ['dyrs'], trackedBills: true },
  committees: ['Legislative Meeting', 'Committee of the Whole', 'Health', 'Youth Affairs'],
  types: ['Hearing', 'Meeting', 'Budget Oversight Hearing'],
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/admin/council-calendar' && !init) return LOADED
    if (path === '/admin/council-calendar/preview') return { events: [{ date: '2026-10-07', time: '12:00', title: 'Youth Affairs roundtable: DYRS', url: 'https://lims.dccouncil.gov/Hearings/hearings/1' }] }
    if (path === '/admin/council-calendar' && init?.method === 'PUT') return { rules: JSON.parse(String(init.body)).rules, sync: { upserted: 4 } }
    throw new Error(`unexpected ${path}`)
  })
})

describe('CouncilCalendarSettings', () => {
  it('shows the saved rules: committees, a committee narrowed to one type, and keywords', async () => {
    render(<CouncilCalendarSettings demoLocked={false} />)
    expect(await screen.findByLabelText('Youth Affairs')).toBeChecked()
    expect(screen.getByLabelText('Health')).not.toBeChecked()
    expect(screen.getByLabelText('Which Committee of the Whole events')).toHaveValue('Meeting')
    expect(screen.getByLabelText('Legislative meetings (including breakfast meetings)')).not.toBeChecked()
    expect(screen.getByLabelText('Agencies and topics')).toHaveValue('dyrs')
  })

  it('previews, then saves the edited rules', async () => {
    const user = userEvent.setup()
    render(<CouncilCalendarSettings demoLocked={false} />)
    await user.click(await screen.findByLabelText('Budget Oversight Hearing'))
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByText('1 upcoming Council event match these choices:')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save and update calendar' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('4 Council events'))
    const put = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'PUT')!
    expect(JSON.parse(String(put[1]!.body)).rules).toEqual({
      include: [{ committee: 'Youth Affairs' }, { committee: 'Committee of the Whole', type: 'Meeting' }],
      types: ['Budget Oversight Hearing'], topicKeywords: ['dyrs'], trackedBills: true,
    })
  })

  it('fills the form from a preset without saving', async () => {
    const user = userEvent.setup()
    render(<CouncilCalendarSettings demoLocked={false} />)
    await user.selectOptions(await screen.findByLabelText('Start from a preset'), 'health')
    await user.click(screen.getByRole('button', { name: 'Fill in' }))
    expect(screen.getByLabelText('Health')).toBeChecked()
    expect(screen.getByLabelText('Youth Affairs')).not.toBeChecked()
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })
})
