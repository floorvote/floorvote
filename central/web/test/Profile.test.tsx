import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Profile from '../src/pages/Profile'

let saved: { name: string; title: string } = { name: 'Ada Lovelace', title: 'Operator support' }

function mockFetch(putStatus = 200) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
    const u = String(url)
    if (u.includes('/admin/dash/profile') && init?.method === 'PUT') {
      if (putStatus !== 200) {
        return new Response(JSON.stringify({ error: { code: 'bad_request', message: 'Name too long (max 100 characters)' } }), { status: putStatus })
      }
      saved = JSON.parse(init.body)
      return new Response(JSON.stringify({ data: { email: 'admin@example.com', ...saved }, meta: {} }))
    }
    if (u.includes('/admin/dash/profile')) {
      return new Response(JSON.stringify({ data: { email: 'admin@example.com', ...saved }, meta: {} }))
    }
    return new Response('{}')
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  saved = { name: 'Ada Lovelace', title: 'Operator support' }
})

describe('Your profile page', () => {
  it('shows the saved name and title for the signed-in superadmin', async () => {
    mockFetch()
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Ada Lovelace'))
    expect(screen.getByLabelText('Title')).toHaveValue('Operator support')
    expect(screen.getByText('admin@example.com')).toBeInTheDocument()
  })

  it('saves an edited name and title via PUT and confirms', async () => {
    mockFetch()
    const spy = vi.spyOn(globalThis, 'fetch')
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Ada Lovelace'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada King' } })
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Engineer' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(screen.getByText(/profile saved/i)).toBeInTheDocument())
    const put = spy.mock.calls.find(c => (c[1] as any)?.method === 'PUT')!
    expect(JSON.parse((put[1] as any).body)).toEqual({ name: 'Ada King', title: 'Engineer' })
  })

  it('shows the error when the save is refused', async () => {
    mockFetch(400)
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(screen.getByText(/name too long/i)).toBeInTheDocument())
  })
})
