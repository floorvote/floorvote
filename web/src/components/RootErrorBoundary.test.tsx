import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, Outlet, redirect } from 'react-router-dom'
import { RootErrorBoundary } from './RootErrorBoundary'
import { ApiError } from '../lib/api'

// Mirrors App.tsx: a pathless layout route carries errorElement={<RootErrorBoundary />}
// and the child route owns the loader/element that throws. `loader: null` models
// the loader-less routes (/profile, every /admin/*) that sit under it too.
function renderBoundary(child: { element?: React.ReactElement; loader?: (() => unknown) | null }) {
  const router = createMemoryRouter(
    [
      {
        element: <Outlet />,
        errorElement: <RootErrorBoundary />,
        children: [{
          index: true,
          element: child.element ?? <div>feed</div>,
          ...(child.loader === null ? {} : { loader: child.loader ?? (() => null) }),
        }],
      },
      { path: '/login', element: <div>login page</div> },
      { path: '/elsewhere', element: <div>elsewhere page</div> },
    ],
    { initialEntries: ['/'] },
  )
  // StrictMode because main.tsx uses it, and the mount/unmount ref bookkeeping in
  // the reload fallback is exactly the kind of thing its remount pass breaks.
  return render(<StrictMode><RouterProvider router={router} /></StrictMode>)
}

/** Route element that throws whatever `boom()` returns, until `boom` returns undefined. */
function makeThrower(boom: () => unknown) {
  return function Thrower() {
    const thrown = boom()
    if (thrown !== undefined) throw thrown
    return <div>feed</div>
  }
}

describe('RootErrorBoundary', () => {
  let reload: ReturnType<typeof vi.fn>
  let originalLocation: PropertyDescriptor | undefined

  // The boundary render logs the caught error through React/RR; silence it so a
  // passing run is readable, and so an unexpected extra error still shows up in
  // the assertions rather than being drowned out.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // location.reload is non-writable and non-configurable in jsdom, so the whole
    // location object gets swapped — the same pattern RequireAuth.test.tsx uses.
    reload = vi.fn()
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location')
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } })
  })
  afterEach(() => {
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation)
    vi.restoreAllMocks()
  })

  it('renders the error card for an ordinary error, without advising a re-login', async () => {
    renderBoundary({ loader: () => { throw new Error('kaboom') } })

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByText('The page could not be loaded.')).toBeInTheDocument()
    // The 401 path redirects before this ever renders, so "sign in again" was
    // advice nobody who saw this card could act on.
    expect(screen.queryByText(/signing in again/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/reload/i)).not.toBeInTheDocument()
    // The Sign in link survives as an escape hatch.
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
  })

  it('recovers in place when "Try again" re-runs a loader that now succeeds', async () => {
    const user = userEvent.setup()
    let fail = true
    const loader = vi.fn(() => {
      if (fail) throw new Error('kaboom')
      return null
    })
    renderBoundary({ loader })

    await screen.findByText('Something went wrong')
    expect(loader).toHaveBeenCalledTimes(1)

    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    // The route element is back — the boundary tore itself down without a reload.
    await waitFor(() => expect(screen.getByText('feed')).toBeInTheDocument())
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument()
    expect(loader).toHaveBeenCalledTimes(2)
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not reload when the revalidated loader fails again', async () => {
    const user = userEvent.setup()
    const loader = vi.fn(() => { throw new Error('kaboom') })
    renderBoundary({ loader })

    await screen.findByText('Something went wrong')
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    // The revalidation ran and failed, so the card is still up — but a real retry
    // happened, so this must not escalate to a reload.
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
  })

  it('falls back to a reload on a route with no loader to revalidate', async () => {
    const user = userEvent.setup()
    // /profile and every /admin/* match no loader at all, so revalidate() is a
    // silent no-op. Their errors are render throws, which a reload can fix.
    const Thrower = makeThrower(() => new Error('render boom'))
    renderBoundary({ element: <Thrower />, loader: null })

    await screen.findByText('Something went wrong')
    expect(reload).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })

  it('does not reload if the boundary is gone before the revalidation settles', async () => {
    // Clicking Sign in right after Try again unmounts this; the pending no-op
    // revalidation must not then reload whatever the user navigated to.
    // fireEvent + unmount are both synchronous, so the ordering here is
    // deterministic: the .then callback cannot run before the unmount.
    const Thrower = makeThrower(() => new Error('render boom'))
    const { unmount } = renderBoundary({ element: <Thrower />, loader: null })

    await screen.findByText('Something went wrong')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    unmount()

    await new Promise((r) => setTimeout(r, 20))
    expect(reload).not.toHaveBeenCalled()
  })

  it('honors a redirect Response thrown during render', async () => {
    // FeedPane's slow path rethrows apiFetchForLoader's `redirect('/login')`
    // during render, where RR renders this boundary instead of navigating.
    const Thrower = makeThrower(() => redirect('/login'))
    renderBoundary({ element: <Thrower /> })

    expect(await screen.findByText('login page')).toBeInTheDocument()
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument()
  })

  it('navigates to the Location of a render-thrown redirect Response', async () => {
    const Thrower = makeThrower(() => redirect('/elsewhere'))
    renderBoundary({ element: <Thrower /> })

    // The Location header wins over the /login fallback.
    expect(await screen.findByText('elsewhere page')).toBeInTheDocument()
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument()
  })

  it('falls back to /login for a redirect Response with no Location', async () => {
    const Thrower = makeThrower(() => new Response(null, { status: 302 }))
    renderBoundary({ element: <Thrower /> })

    expect(await screen.findByText('login page')).toBeInTheDocument()
  })

  it('still shows the card for a render-thrown non-redirect Response', async () => {
    // billDetailLoader throws Responses with 409/500; those must keep hitting the
    // card, not be mistaken for a session expiry.
    const Thrower = makeThrower(() => new Response('conflict', { status: 409 }))
    renderBoundary({ element: <Thrower /> })

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument()
    expect(screen.queryByText('login page')).not.toBeInTheDocument()
  })

  it('still shows the card for a loader-thrown non-redirect Response', async () => {
    // RR unwraps a loader-thrown Response into an ErrorResponse before it reaches
    // useRouteError, so this exercises a different shape than the render case.
    renderBoundary({ loader: () => { throw new Response('server error', { status: 500 }) } })

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument()
    expect(screen.queryByText('login page')).not.toBeInTheDocument()
  })

  it('does not treat a loader-thrown 3xx ErrorResponse as a redirect', async () => {
    // A 3xx without a Location is not a redirect RR can follow, so it lands here
    // as an ErrorResponse carrying a 300-range status. The `instanceof Response`
    // guard is what keeps a status-only check from navigating to nowhere; drop it
    // for duck typing and this renders a blank page instead of the card.
    renderBoundary({ loader: () => { throw new Response(null, { status: 304 }) } })

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument()
  })

  it('redirects a 401 ApiError to /login', async () => {
    renderBoundary({ loader: () => { throw new ApiError(401, 'Not authenticated') } })

    expect(await screen.findByText('login page')).toBeInTheDocument()
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument()
  })

  it('shows the card for a non-401 ApiError', async () => {
    renderBoundary({ loader: () => { throw new ApiError(500, 'Server error') } })

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument()
    expect(screen.queryByText('login page')).not.toBeInTheDocument()
  })
})
