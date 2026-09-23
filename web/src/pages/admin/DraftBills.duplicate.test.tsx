import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, Outlet } from 'react-router-dom'
import { useState } from 'react'
import { DraftBills } from './DraftBills'
import { UnsavedTextProvider } from '../../lib/unsavedText'
import * as api from '../../lib/api'

vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false }),
}))

// The real RichTextEditor is a Tiptap instance; stub it with a textarea that
// registers with the unsaved-text registry exactly as the real one does, so the
// nav guard is exercised without pulling ProseMirror into jsdom.
vi.mock('../../components/RichTextEditor', async () => {
  const { useUnsavedRegistration } = await import('../../lib/unsavedText')
  return {
    RichTextEditor: ({ onChange, placeholder }: { onChange?: (html: string) => void; placeholder?: string }) => {
      const [value, setValue] = useState('')
      useUnsavedRegistration({ isDirty: () => value.trim().length > 0, reset: () => setValue('') })
      return (
        <textarea
          aria-label={placeholder}
          value={value}
          onChange={e => { setValue(e.target.value); onChange?.(`<p>${e.target.value}</p>`) }}
        />
      )
    },
  }
})

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        element: <UnsavedTextProvider><Outlet /></UnsavedTextProvider>,
        children: [
          { path: '/admin/drafts', element: <DraftBills /> },
          { path: '/bills/:billId', element: <div>bill detail</div> },
        ],
      },
    ],
    { initialEntries: ['/admin/drafts'] },
  )
  return render(<RouterProvider router={router} />)
}

describe('DraftBills duplicate-create regression', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('creates exactly one draft and does not prompt about unsaved text', async () => {
    const posts: unknown[] = []
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/bills/drafts') return { drafts: [] } as never
      // The server reports a configured single state, so the State field stays
      // hidden — this test isn't exercising that field, just the
      // create-then-navigate flow.
      if (path === '/bills/facets') return { state: { UT: 5 } } as never
      if (path.startsWith('/bills/draft-defaults')) return { billNumber: 'D1', year: 2026, tenantState: 'UT' } as never
      if (path === '/bills/draft') { posts.push(init); return { id: 'new-draft-id' } as never }
      return {} as never
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /add draft bill/i }))
    await user.type(screen.getByLabelText(/title/i), 'Pre-filed elections bill')
    await user.type(screen.getByLabelText(/paste or type the bill text/i), 'AN ACT CONCERNING')
    await user.click(screen.getByRole('button', { name: /create draft/i }))

    expect(await screen.findByText('bill detail')).toBeInTheDocument()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(posts).toHaveLength(1)
  })
})
