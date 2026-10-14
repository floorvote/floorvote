import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PersonalNote } from './PersonalNote'
import * as api from '../lib/api'

// The editor is a TipTap instance in the app. Here it shows what it would open
// with and saves that unchanged, which is all these tests need from it.
vi.mock('./RichTextEditor', () => ({
  RichTextEditor: ({ initialContent, onSubmit }: { initialContent?: string; onSubmit: (html: string) => void }) => (
    <div>
      <div data-testid="editor">{initialContent}</div>
      <button type="button" onClick={() => onSubmit(initialContent ?? '')}>Save</button>
    </div>
  ),
}))

const NOTES = [
  { billId: 'a190', billNumber: 'A190', content: '<p>On A190</p>', updatedAt: '2026-10-01 00:00:00' },
  { billId: 'b1713', billNumber: 'S1713', content: '<p>On S1713</p>', updatedAt: '2026-10-01 00:00:00' },
]
const MERGED = '<p><strong>A190</strong></p><p>On A190</p><p><strong>S1713</strong></p><p>On S1713</p>'

describe('a personal note across a companion group', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows notes from several bills stacked under their bill numbers', () => {
    render(<PersonalNote billId="a190" initialContent={MERGED} notes={NOTES} />)
    const a = screen.getByRole('heading', { name: 'A190' })
    const s = screen.getByRole('heading', { name: 'S1713' })
    expect(a.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('On A190')).toBeInTheDocument()
    expect(screen.getByText('On S1713')).toBeInTheDocument()
  })

  it('opens the stacked notes as one note and saves it on the bill being viewed', async () => {
    const put = vi.spyOn(api, 'apiFetch').mockResolvedValue({ content: MERGED } as never)
    render(<PersonalNote billId="a190" initialContent={MERGED} notes={NOTES} />)
    expect(screen.getByRole('heading', { name: 'S1713' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Personal note' }))
    expect(screen.getByTestId('editor').textContent).toBe(MERGED)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    // It names the companion notes it showed, so the API merges away only those.
    await waitFor(() => expect(put).toHaveBeenCalledWith('/bills/a190/note', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ content: MERGED, merges: ['b1713'] }) })))
    // Once saved it is one note, so the per-bill headings go.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'S1713' })).toBeNull())
  })

  it('names no merged notes when it showed a single note', async () => {
    const put = vi.spyOn(api, 'apiFetch').mockResolvedValue({ content: '<p>On A190</p>' } as never)
    render(<PersonalNote billId="a190" initialContent="<p>On A190</p>" notes={[NOTES[0]]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Personal note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toHaveBeenCalledWith('/bills/a190/note', expect.objectContaining({ body: JSON.stringify({ content: '<p>On A190</p>', merges: [] }) })))
  })
})
