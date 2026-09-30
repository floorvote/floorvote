import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiFetch } from '../lib/api'
import { DeepAnalysisPanel } from './DeepAnalysisPanel'

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message) }
  },
}))
vi.mock('../context/DemoContext', () => ({ useDemo: () => ({ demoMode: false, demoLocked: false }) }))

const DONE = {
  enabled: true, status: 'done', completedAt: '2026-09-29 14:00:00', model: 'claude-opus-5-5', stale: false,
  content: {
    bottomLine: 'Raises the age for adult prosecution review.',
    whatChanges: [{ section: 'Sec. 2', change: 'Amends D.C. Code 16-2307', quote: 'shall not' }],
    whoItAffects: ['Youth charged as adults'], howItFits: [], openQuestions: ['Who funds it?'],
    testimony: { questions: [], amendments: ['Add reporting'] }, caveats: [],
  },
}

beforeEach(() => vi.mocked(apiFetch).mockReset())

describe('DeepAnalysisPanel', () => {
  it('renders nothing when the operator has not turned it on', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ enabled: false, status: 'none' })
    const { container } = render(<DeepAnalysisPanel kind="bill" subjectId="b1" isAdmin />)
    await new Promise(r => setTimeout(r, 0))
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a finished analysis with its sections and model', async () => {
    vi.mocked(apiFetch).mockResolvedValue(DONE)
    render(<DeepAnalysisPanel kind="bill" subjectId="b1" isAdmin={false} />)
    expect(await screen.findByText('Raises the age for adult prosecution review.')).toBeInTheDocument()
    expect(screen.getByText('Sec. 2:')).toBeInTheDocument()
    expect(screen.getByText('Amendments worth proposing')).toBeInTheDocument()
    expect(screen.getByText(/claude-opus-5-5, 2026-09-29/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Redo' })).not.toBeInTheDocument()
  })

  it('lets an admin request one and shows it pending', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ enabled: true, status: 'none' })
      .mockResolvedValueOnce({ enabled: true, status: 'pending' })
    const user = userEvent.setup()
    render(<DeepAnalysisPanel kind="hearing" subjectId="e1" isAdmin />)
    await user.click(await screen.findByRole('button', { name: 'Request a hearing brief' }))
    expect(vi.mocked(apiFetch)).toHaveBeenLastCalledWith('/deep/hearing/e1/request', { method: 'POST' })
    expect(await screen.findByText('Pending: usually ready within a few hours')).toBeInTheDocument()
  })
})
