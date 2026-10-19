import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { CommentAttachments } from './CommentAttachments'

const files = [
  { id: 'a1', name: 'Fiscal Note.pdf', contentType: 'application/pdf', size: 1536 },
  { id: 'a2', name: 'Budget.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 4 * 1024 * 1024 },
  { id: 'a3', name: 'map #2.png', contentType: 'image/png', size: 900 },
]

describe('CommentAttachments', () => {
  it('renders nothing for a comment with no files', () => {
    const { container } = render(<CommentAttachments attachments={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the payload has no attachments field (an older server)', () => {
    const { container } = render(<CommentAttachments attachments={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('lists each file with its name, type, and size', () => {
    render(<CommentAttachments attachments={files} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('Fiscal Note.pdf')
    expect(rows[0]).toHaveTextContent('PDF · 1.5 KB')
    expect(rows[1]).toHaveTextContent('Spreadsheet · 4 MB')
    expect(rows[2]).toHaveTextContent('Image · 900 B')
  })

  it('wears a tile for the type', () => {
    render(<CommentAttachments attachments={files} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('PDF')
    expect(rows[1]).toHaveTextContent('XLS')
    expect(rows[2]).toHaveTextContent('IMG')
  })

  it('offers a Download link to the authenticated route, as a download', () => {
    render(<CommentAttachments attachments={files} />)
    const link = within(screen.getAllByRole('listitem')[2]).getByRole('link', { name: 'Download map #2.png' })
    expect(link).toHaveAttribute('href', '/api/attachments/a3')
    expect(link).toHaveAttribute('download', 'map #2.png')
    expect(link).toHaveTextContent('Download')
  })

  it('names the list for assistive technology', () => {
    render(<CommentAttachments attachments={files} />)
    expect(screen.getByRole('list', { name: 'Attachments' })).toBeInTheDocument()
  })
})
