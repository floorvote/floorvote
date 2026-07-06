import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, Link, Outlet } from 'react-router-dom'
import { UnsavedTextProvider, useUnsavedRegistration } from './unsavedText'

const resetSpy = vi.fn()
let dirty = true

function DirtyPage() {
  useUnsavedRegistration({ isDirty: () => dirty, reset: resetSpy })
  return <div>page one <Link to="/two">go two</Link></div>
}

function Layout() {
  return <UnsavedTextProvider><Outlet /></UnsavedTextProvider>
}

function renderApp() {
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          { path: '/', element: <DirtyPage /> },
          { path: '/two', element: <div>page two</div> },
        ],
      },
    ],
    { initialEntries: ['/'] },
  )
  return render(<RouterProvider router={router} />)
}

beforeEach(() => { resetSpy.mockClear(); dirty = true; vi.restoreAllMocks() })

describe('UnsavedTextProvider nav guard', () => {
  it('blocks navigation and keeps the page when the user cancels', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderApp()
    fireEvent.click(screen.getByText('go two'))
    expect(confirmSpy).toHaveBeenCalled()
    expect(screen.getByText(/page one/)).toBeInTheDocument()
    expect(screen.queryByText('page two')).not.toBeInTheDocument()
    expect(resetSpy).not.toHaveBeenCalled()
  })

  it('resets the dirty fields and proceeds when the user confirms', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderApp()
    fireEvent.click(screen.getByText('go two'))
    expect(await screen.findByText('page two')).toBeInTheDocument()
    expect(resetSpy).toHaveBeenCalled()
  })

  it('does not prompt when nothing is dirty', async () => {
    dirty = false
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderApp()
    fireEvent.click(screen.getByText('go two'))
    expect(await screen.findByText('page two')).toBeInTheDocument()
    expect(confirmSpy).not.toHaveBeenCalled()
  })
})
