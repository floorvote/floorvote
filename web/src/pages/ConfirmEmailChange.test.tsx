import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as api from '../lib/api'
import { ApiError } from '../lib/api'
import { ConfirmEmailChange, EmailChangeNotMe } from './ConfirmEmailChange'

afterEach(() => {
  vi.restoreAllMocks()
  document.head.querySelectorAll('meta[name="referrer"]').forEach(m => m.remove())
})

type Status = { status: 'valid'; email: string; byAdmin?: boolean } | { status: 'expired'; byAdmin?: boolean } | { status: 'invalid' }

/** Route apiFetch: the status GET answers `status`; the confirm POST answers `confirm`. */
function server(status: Status, confirm: unknown = { ok: true, email: 'jane@newjob.org' }) {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/auth/email-change/status') return status as never
    if (path === '/auth/email-change/confirm') {
      if (confirm instanceof Error) throw confirm
      return confirm as never
    }
    throw new Error(`unexpected ${path}`)
  })
}

const posts = (spy: ReturnType<typeof server>) => spy.mock.calls.filter(c => c[0] === '/auth/email-change/confirm')

const statusCalls = (spy: ReturnType<typeof server>) => spy.mock.calls.filter(c => c[0] === '/auth/email-change/status')

const renderPage = (token = 'abc123') => {
  // The router reads the URL it is given; the real address bar is what a
  // browser would show, and what ends up in history and logs.
  window.history.replaceState({}, '', `/auth/confirm-email?token=${token}`)
  return render(<MemoryRouter initialEntries={[`/auth/confirm-email?token=${token}`]}><ConfirmEmailChange /></MemoryRouter>)
}

describe('ConfirmEmailChange', () => {
  it('loading the page only reads the status: it shows the new address and a button, and posts nothing', async () => {
    const spy = server({ status: 'valid', email: 'jane@newjob.org' })
    renderPage()
    expect(await screen.findByRole('button', { name: 'Confirm new email' })).toBeInTheDocument()
    expect(screen.getByText('jane@newjob.org')).toBeInTheDocument()
    expect(statusCalls(spy)).toEqual([['/auth/email-change/status', { method: 'POST', body: JSON.stringify({ token: 'abc123' }) }]])
    expect(posts(spy)).toHaveLength(0)
  })

  it('takes the token out of the address bar once read, and still confirms with it', async () => {
    const spy = server({ status: 'valid', email: 'jane@newjob.org' })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm new email' }))
    await screen.findByRole('heading', { name: 'Email Changed' })
    expect(window.location.search).toBe('')
    expect(window.location.href).not.toContain('abc123')
    expect(posts(spy)).toEqual([['/auth/email-change/confirm', { method: 'POST', body: JSON.stringify({ token: 'abc123' }) }]])
  })

  it('pressing the button confirms with the token and says the change is done', async () => {
    const spy = server({ status: 'valid', email: 'jane@newjob.org' })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm new email' }))
    expect(await screen.findByRole('heading', { name: 'Email Changed' })).toBeInTheDocument()
    expect(screen.getByText(/Your sign-in email is now/)).toHaveTextContent('Your sign-in email is now jane@newjob.org.')
    expect(posts(spy)).toEqual([['/auth/email-change/confirm', { method: 'POST', body: JSON.stringify({ token: 'abc123' }) }]])
  })

  it("shows the server's reason when the confirm is refused", async () => {
    server({ status: 'valid', email: 'jane@newjob.org' }, new ApiError(409, 'That address is already used by another member.'))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm new email' }))
    expect(await screen.findByText('That address is already used by another member.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm new email' })).not.toBeInTheDocument()
  })

  it.each([
    [{ status: 'expired' } as Status, 'This link has expired. Request the change again from your Account page.'],
    [{ status: 'invalid' } as Status, 'This link is no longer valid. It may have been used already, or replaced by a newer request.'],
  ])('offers no button for a dead link (%o)', async (status, message) => {
    const spy = server(status)
    renderPage()
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm new email' })).not.toBeInTheDocument()
    expect(posts(spy)).toHaveLength(0)
  })

  describe('when an admin asked for the change', () => {
    it('says so, and warns that everyone is signed out', async () => {
      server({ status: 'valid', email: 'jane@newjob.org', byAdmin: true })
      renderPage()
      expect(await screen.findByRole('button', { name: 'Confirm new email' })).toBeInTheDocument()
      expect(screen.getByText(/An admin asked to make/)).toHaveTextContent('An admin asked to make jane@newjob.org the sign-in email for your FloorVote account. Confirm the change?')
      expect(screen.getByText(/signed out everywhere/)).toBeInTheDocument()
    })

    it('tells the member to sign in again once it is done, since no session is kept', async () => {
      server({ status: 'valid', email: 'jane@newjob.org', byAdmin: true }, { ok: true, email: 'jane@newjob.org', byAdmin: true })
      renderPage()
      fireEvent.click(await screen.findByRole('button', { name: 'Confirm new email' }))
      expect(await screen.findByRole('heading', { name: 'Email Changed' })).toBeInTheDocument()
      expect(screen.getByText(/Sign in again with the new address/)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
    })

    it.each([
      [{ status: 'expired', byAdmin: true } as Status, 'This link has expired. Ask the admin who requested the change to request it again.'],
      [{ status: 'invalid' } as Status, 'This link is no longer valid. It may have been used already, or replaced by a newer request.'],
    ])('does not send the member to an Account page to request again (%j)', async (status, message) => {
      server(status)
      renderPage()
      expect(await screen.findByText(message)).toBeInTheDocument()
      if ('byAdmin' in status) {
        expect(screen.queryByText(/Account page/)).not.toBeInTheDocument()
        expect(screen.queryByText(/from your Account page/)).not.toBeInTheDocument()
      }
    })
  })

  it('sends no referrer from the page', async () => {
    server({ status: 'valid', email: 'jane@newjob.org' })
    renderPage()
    await screen.findByRole('button', { name: 'Confirm new email' })
    expect(document.head.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer')
  })

  it('serves the page with Referrer-Policy: no-referrer', () => {
    // The HTML comes from Workers Assets, not the Worker, so the header is set
    // in the static _headers file.
    const here = dirname(fileURLToPath(import.meta.url))
    const text = readFileSync(resolve(here, '../../public/_headers'), 'utf8')
    expect(text).toMatch(/^\/auth\/confirm-email\n {2}Referrer-Policy: no-referrer$/m)
  })
})

describe('EmailChangeNotMe', () => {
  type NotMeStatus = { status: 'valid' | 'expired' | 'invalid' }

  /** Route apiFetch: the status call answers `status`, and the press answers `press`. */
  function notMeServer(status: NotMeStatus, press: unknown = { ok: true, alerted: true, cancelled: true }) {
    return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/auth/email-change/not-me/status') return status as never
      if (path === '/auth/email-change/not-me') {
        if (press instanceof Error) throw press
        return press as never
      }
      throw new Error(`unexpected ${path}`)
    })
  }
  const presses = (spy: ReturnType<typeof notMeServer>) => spy.mock.calls.filter(c => c[0] === '/auth/email-change/not-me')
  const notMeStatusCalls = (spy: ReturnType<typeof notMeServer>) => spy.mock.calls.filter(c => c[0] === '/auth/email-change/not-me/status')

  const renderNotMe = (token = 'tok456') => {
    window.history.replaceState({}, '', token ? `/auth/not-me?token=${token}` : '/auth/not-me')
    return render(<MemoryRouter initialEntries={[token ? `/auth/not-me?token=${token}` : '/auth/not-me']}><EmailChangeNotMe /></MemoryRouter>)
  }
  const BUTTON = "This wasn't me"

  it('loading the page only reads the status: it offers a button and does nothing', async () => {
    const spy = notMeServer({ status: 'valid' })
    renderNotMe()
    expect(await screen.findByRole('button', { name: BUTTON })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: "Didn't Ask for This Change?" })).toBeInTheDocument()
    expect(screen.getByText(/it cancels that change, but it doesn't undo one that has/)).toBeInTheDocument()
    expect(notMeStatusCalls(spy)).toEqual([['/auth/email-change/not-me/status', { method: 'POST', body: JSON.stringify({ token: 'tok456' }) }]])
    expect(presses(spy)).toHaveLength(0)
  })

  it('takes the token out of the address bar once read, and still presses with it', async () => {
    const spy = notMeServer({ status: 'valid' })
    renderNotMe()
    fireEvent.click(await screen.findByRole('button', { name: BUTTON }))
    await screen.findByRole('heading', { name: "You're Signed Out Everywhere" })
    expect(window.location.search).toBe('')
    expect(window.location.href).not.toContain('tok456')
    expect(presses(spy)).toEqual([['/auth/email-change/not-me', { method: 'POST', body: JSON.stringify({ token: 'tok456' }) }]])
  })

  it('says the admins were emailed, and that the change was not undone', async () => {
    notMeServer({ status: 'valid' })
    renderNotMe()
    fireEvent.click(await screen.findByRole('button', { name: BUTTON }))
    expect(await screen.findByText(/We emailed your FloorVote admins/)).toBeInTheDocument()
    expect(screen.getByText(/A change you asked for that hadn't been confirmed was cancelled/)).toBeInTheDocument()
    expect(screen.getByText(/already took effect isn't undone/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Sign in/ })).toHaveAttribute('href', '/login')
  })

  it('says nothing was cancelled only when the server did not cancel anything', async () => {
    notMeServer({ status: 'valid' }, { ok: true, alerted: true, cancelled: false })
    renderNotMe()
    fireEvent.click(await screen.findByRole('button', { name: BUTTON }))
    expect(await screen.findByText(/already took effect isn't undone/)).toBeInTheDocument()
    expect(screen.queryByText(/was cancelled/)).not.toBeInTheDocument()
  })

  it('is honest when no alert could be sent', async () => {
    notMeServer({ status: 'valid' }, { ok: true, alerted: false })
    renderNotMe()
    fireEvent.click(await screen.findByRole('button', { name: BUTTON }))
    expect(await screen.findByText(/couldn't email your FloorVote admins/)).toBeInTheDocument()
    expect(screen.queryByText(/We emailed your FloorVote admins/)).not.toBeInTheDocument()
  })

  it("shows the server's reason when the press is refused, with no way to press again", async () => {
    notMeServer({ status: 'valid' }, new ApiError(404, 'This link is no longer valid. It may have been used already.'))
    renderNotMe()
    fireEvent.click(await screen.findByRole('button', { name: BUTTON }))
    expect(await screen.findByText('This link is no longer valid. It may have been used already.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: BUTTON })).not.toBeInTheDocument()
  })

  it.each([
    [{ status: 'expired' } as NotMeStatus, 'Link Expired', /has expired/],
    [{ status: 'invalid' } as NotMeStatus, 'Link No Longer Valid', /no longer valid/],
  ])('offers no button for a dead link (%o)', async (status, heading, message) => {
    const spy = notMeServer(status)
    renderNotMe()
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument()
    expect(screen.getByText(message)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: BUTTON })).not.toBeInTheDocument()
    expect(presses(spy)).toHaveLength(0)
  })

  it('treats an address with no token as a dead link, without calling the server', async () => {
    const spy = notMeServer({ status: 'valid' })
    renderNotMe('')
    expect(await screen.findByRole('heading', { name: 'Link No Longer Valid' })).toBeInTheDocument()
    expect(spy).not.toHaveBeenCalled()
  })

  it('still offers the button when the status cannot be read, and lets the press say what is wrong', async () => {
    vi.spyOn(api, 'apiFetch').mockRejectedValue(new Error('offline'))
    renderNotMe()
    expect(await screen.findByRole('button', { name: BUTTON })).toBeInTheDocument()
  })

  it('sends no referrer from the page, and is served with Referrer-Policy: no-referrer', async () => {
    notMeServer({ status: 'valid' })
    renderNotMe()
    await screen.findByRole('button', { name: BUTTON })
    expect(document.head.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer')
    const here = dirname(fileURLToPath(import.meta.url))
    const text = readFileSync(resolve(here, '../../public/_headers'), 'utf8')
    expect(text).toMatch(/^\/auth\/not-me\n {2}Referrer-Policy: no-referrer$/m)
  })
})

