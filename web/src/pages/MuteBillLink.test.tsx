import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import * as api from '../lib/api'
import { ApiError } from '../lib/api'
import { MuteBillLink } from './MuteBillLink'

// The page a reply email's "Mute this bill" footer link opens (/mute-bill). It
// needs no session: the link is signed for one member and one bill. Mail
// scanners follow links, so loading the page mutes nothing. Only the button does.

afterEach(() => {
  vi.restoreAllMocks()
  document.head.querySelectorAll('meta[name="referrer"]').forEach(m => m.remove())
})

const MUTED = { billNumber: 'HB 1', billTitle: 'Voter ID Act', billPath: '/RI/2026/HB 1' }

function server(result: unknown = MUTED) {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/mute-link') {
      if (result instanceof Error) throw result
      return result as never
    }
    throw new Error(`unexpected ${path}`)
  })
}

const posts = (spy: ReturnType<typeof server>) => spy.mock.calls.filter(c => c[0] === '/mute-link')

function renderPage(token: string | null = 'abc.def') {
  const url = token === null ? '/mute-bill' : `/mute-bill?token=${token}`
  window.history.replaceState({}, '', url)
  return render(<MemoryRouter initialEntries={[url]}><MuteBillLink /></MemoryRouter>)
}

describe('MuteBillLink', () => {
  it('asks before muting: loading the page posts nothing', async () => {
    const spy = server()
    renderPage()
    expect(await screen.findByRole('button', { name: 'Mute comments' })).toBeInTheDocument()
    expect(posts(spy)).toHaveLength(0)
  })

  it('mutes with the token when the button is pressed and names the bill', async () => {
    const spy = server()
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Mute comments' }))

    expect(await screen.findByRole('heading', { name: 'Comments Muted' })).toBeInTheDocument()
    expect(screen.getByText(/HB 1/)).toBeInTheDocument()
    expect(screen.getByText(/mentions still reach you/i)).toBeInTheDocument()
    expect(screen.getByText('To unmute, open the bill and select “Unmute comments.”')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /open the bill/i })).toHaveAttribute('href', '/RI/2026/HB 1')
    expect(posts(spy)).toEqual([['/mute-link', { method: 'POST', body: JSON.stringify({ token: 'abc.def' }) }]])
  })

  it('takes the token out of the address bar and sends no referrer', async () => {
    server()
    renderPage()
    await screen.findByRole('button', { name: 'Mute comments' })
    expect(window.location.href).not.toContain('abc.def')
    expect(document.head.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer')
  })

  it('says the link is not valid when the server refuses it', async () => {
    server(new ApiError(404, 'This link is not valid.'))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Mute comments' }))
    expect(await screen.findByText('This link is not valid.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Comments Muted' })).not.toBeInTheDocument()
  })

  it('offers no button when the link has no token', async () => {
    const spy = server()
    renderPage(null)
    expect(await screen.findByText(/link is not valid/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mute comments' })).not.toBeInTheDocument()
    expect(posts(spy)).toHaveLength(0)
  })
})
