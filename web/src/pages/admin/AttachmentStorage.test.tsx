import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// The admin's view of comment attachment storage (#465): bytes used against
// the instance quota, from GET /attachments/usage.

vi.mock('../../lib/api', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../../lib/api'
import { AttachmentStorage } from './AttachmentStorage'

const mockFetch = vi.mocked(apiFetch)
const GB = 1024 ** 3

beforeEach(() => { mockFetch.mockReset() })

describe('AttachmentStorage', () => {
  it('shows the storage used against the quota', async () => {
    mockFetch.mockResolvedValue({ enabled: true, usedBytes: 1.5 * GB, quotaBytes: 5 * GB })
    render(<AttachmentStorage />)
    expect(await screen.findByText('1.5 GB of 5 GB used')).toBeInTheDocument()
    expect(mockFetch).toHaveBeenCalledWith('/attachments/usage')
    const bar = screen.getByRole('progressbar', { name: 'Attachment storage used' })
    expect(bar).toHaveAttribute('aria-valuenow', '30')
  })

  it('shows nothing when attachments are off for the instance', async () => {
    mockFetch.mockResolvedValue({ enabled: false, usedBytes: 0, quotaBytes: 5 * GB })
    const { container } = render(<AttachmentStorage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('shows nothing when the usage cannot be read', async () => {
    mockFetch.mockRejectedValue(new Error('403'))
    const { container } = render(<AttachmentStorage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('warns when the quota is nearly full', async () => {
    mockFetch.mockResolvedValue({ enabled: true, usedBytes: 4.8 * GB, quotaBytes: 5 * GB })
    render(<AttachmentStorage />)
    expect(await screen.findByText(/nearly full/)).toBeInTheDocument()
  })

  it('says new uploads are refused when it is full', async () => {
    mockFetch.mockResolvedValue({ enabled: true, usedBytes: 5 * GB, quotaBytes: 5 * GB })
    render(<AttachmentStorage />)
    expect(await screen.findByText(/new uploads are refused/)).toBeInTheDocument()
  })
})
