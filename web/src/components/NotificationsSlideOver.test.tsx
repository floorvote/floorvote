import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { NotificationsSlideOver } from './NotificationsSlideOver'
import { NotificationsProvider } from '../context/NotificationsContext'
import { MENTION_STYLE } from '../../../shared/mentionStyle'

// Mutable flag so individual tests can opt into demoLocked without a
// module-level mock rewrite per test (mirrors Members.roleRename.test.tsx).
const demoState = vi.hoisted(() => ({ demoMode: false, demoLocked: false }))
// Lets a test hold `GET /notifications` open, so the ordering against
// mark-read is observable rather than a matter of which request wins.
const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null }))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: demoState.demoMode, demoLocked: demoState.demoLocked }),
}))

// The @role-mention attribution chip ("mentioned @Board") previously showed
// its member list only in a hover-triggered tooltip (onMouseEnter/onMouseLeave)
// — mouse-only, so keyboard and touch users, and screen-reader users who never
// hover, had no way to see who's in the role. It must surface that list
// without depending on hover.
vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/notifications' && (!init || init.method === undefined)) {
      if (gate.hold) await gate.hold
      return {
        unreadCount: 1,
        mentions: [
          {
            id: 'm1',
            commentId: 'c1',
            billId: 'b1',
            billNumber: 'SB123',
            billTitle: 'A test bill',
            billState: 'NJ',
            sessionSlug: 'session-1',
            authorName: 'Alice Author',
            authorSubtitle: 'Research Associate',
            commentPreview: 'preview',
            commentHtml: '<p>Please review.</p>',
            sourceType: 'role',
            sourceLabel: 'Board',
            createdAt: new Date().toISOString(),
            isUnread: true,
          },
          // Second row whose comment body *opens* with the same role pill named
          // in its attribution line — the common case, and the reason the body
          // can't have a leading pill stripped out of it (see the describe below).
          {
            id: 'm2',
            commentId: 'c2',
            billId: 'b2',
            billNumber: 'HB4427',
            billTitle: 'Another test bill',
            billState: 'NJ',
            sessionSlug: 'session-1',
            authorName: 'Karen Waters',
            authorSubtitle: null,
            commentPreview: 'preview',
            commentHtml: '<p><span data-type="mention" data-id="role:r2" data-label="Infrastructure">@Infrastructure</span> can someone cover the hearing?</p>',
            sourceType: 'role',
            sourceLabel: 'Infrastructure',
            createdAt: new Date().toISOString(),
            isUnread: false,
          },
        ],
      }
    }
    if (path === '/roles') {
      return [
        {
          id: 'r1',
          name: 'Board',
          members: [
            { id: 'u1', name: 'Alice Member', subtitle: null },
            { id: 'u2', name: 'Bob Member', subtitle: 'Treasurer' },
          ],
        },
        {
          id: 'r2',
          name: 'Infrastructure',
          members: [{ id: 'u3', name: 'Carol Member', subtitle: null }],
        },
      ]
    }
    if (path === '/notifications/mark-read') return {}
    return {}
  }),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  },
}))

function renderPanel() {
  return render(
    <MemoryRouter>
      <NotificationsProvider>
        <NotificationsSlideOver onClose={() => {}} />
      </NotificationsProvider>
    </MemoryRouter>,
  )
}

describe('NotificationsSlideOver role-mention chip', () => {
  it('exposes its member list without requiring hover', async () => {
    renderPanel()
    const chip = await screen.findByText('@Board')
    // The title is populated only once the independent /roles fetch lands, which
    // is no longer batched with the mentions render — so assert on it inside
    // waitFor rather than synchronously after the chip appears.
    await waitFor(() => {
      expect(chip.getAttribute('title')).toMatch(/Alice Member/)
      expect(chip.getAttribute('title')).toMatch(/Bob Member/)
    })
  })
})

describe('NotificationsSlideOver row layout', () => {
  it('states the mention as one sentence — the author name and the role chip share a line, with no separate attribution line', async () => {
    renderPanel()
    const chip = await screen.findByText('@Board')
    // The sentence mirrors the mention email's own phrasing, so the panel reads
    // as the message the recipient already received. If someone re-splits this
    // into an author line plus a standalone "mentioned …" line, the chip stops
    // being a sibling of the author name and this fails.
    const line = chip.closest('div') as HTMLElement
    expect(line.textContent).toMatch(/Alice Author\s+mentioned\s+@Board/)
  })

  it('omits the author subtitle', async () => {
    renderPanel()
    await screen.findByText('@Board')
    // Deliberately dropped: in a 400px panel the subtitle cost a line's worth of
    // attention for a detail the name usually carries. The API still sends it.
    expect(screen.queryByText(/Research Associate/)).toBeNull()
  })

  it('keeps the bill identifiable in a footer line', async () => {
    renderPanel()
    await screen.findByText('@Board')
    expect(screen.getByText('A test bill')).toBeInTheDocument()
    expect(screen.getByText(/SB123/)).toBeInTheDocument()
  })
})

describe('a role mention that also opens the quoted comment', () => {
  it('renders the pill in both places — the comment body is verbatim, because a mention can sit anywhere in a sentence', async () => {
    renderPanel()
    await screen.findAllByText('@Infrastructure')
    // Re-query inside waitFor rather than hold the nodes from findAllByText:
    // nodes captured that way were observed going stale here (a later query
    // finds a pill inside .notif-comment that a held reference's .closest()
    // no longer sees) — the cause is under separate investigation. Asserting
    // on freshly queried nodes tests the rendered result rather than the
    // timing of when the query happened to run.
    await waitFor(() => {
      const pills = screen.getAllByText('@Infrastructure')
      // Once in the attribution sentence, once inside the quoted comment. Stripping
      // the body's leading pill would only work for mentions that happen to lead
      // the comment, and would mangle "cc @Infrastructure on this".
      expect(pills).toHaveLength(2)
      expect(pills.some(p => p.closest('.notif-comment') !== null)).toBe(true)
      expect(pills.some(p => p.closest('.notif-comment') === null)).toBe(true)
    })
  })

  it('styles the attribution pill at the shared mention weight, so the repeat reads as intentional', async () => {
    renderPanel()
    const pills = await screen.findAllByText('@Infrastructure')
    const attribution = pills.find(p => p.closest('.notif-comment') === null) as HTMLElement
    // Regression guard: this chip used to be semibold (600) while every other
    // mention pill — the one in the comment body, ROLE_CHIP, and the emails —
    // was medium (500). Printing the pill twice per row made the mismatch plain.
    expect(attribution.style.fontWeight).toBe(String(MENTION_STYLE.weight))
  })
})

describe('mark-read ordering', () => {
  afterEach(() => { gate.hold = null })

  it('marks read only after the unread state has been read back', async () => {
    // These two requests used to be fired concurrently, so whether a row rendered
    // with its unread treatment depended on which one reached the DB first. Holding
    // the GET open makes the ordering observable: with the old code the POST went
    // out immediately and this fails.
    let release!: () => void
    gate.hold = new Promise<void>(r => { release = r })
    const { apiFetch } = await import('../lib/api')
    vi.mocked(apiFetch).mockClear()
    renderPanel()

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/notifications'))
    expect(apiFetch).not.toHaveBeenCalledWith('/notifications/mark-read', expect.anything())

    release()
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/notifications/mark-read', expect.objectContaining({ method: 'POST' })))
  })

  it('paints the unread row differently from a read one', async () => {
    renderPanel()
    const unreadRow = (await screen.findByText('@Board')).closest('a') as HTMLElement
    const readRow = (await screen.findAllByText('@Infrastructure'))[0].closest('a') as HTMLElement
    // The highlight is the whole point of resolving the race above — if the rows
    // are indistinguishable, marking read too early has erased it.
    expect(unreadRow).not.toBe(readRow)
    expect(unreadRow.style.background).not.toBe(readRow.style.background)
    expect(readRow.style.borderLeft).toContain('transparent')
    expect(unreadRow.style.borderLeft).not.toContain('transparent')
  })
})

describe('NotificationsSlideOver instant open', () => {
  it('does not fetch /notifications itself — the context already holds them', async () => {
    const { apiFetch } = await import('../lib/api')
    vi.mocked(apiFetch).mockClear()
    renderPanel()
    await screen.findByText('@Board')
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/notifications/mark-read', expect.objectContaining({ method: 'POST' })))

    const calls = vi.mocked(apiFetch).mock.calls
    const postIndex = calls.findIndex(([path, init]) => path === '/notifications/mark-read' && (init as RequestInit | undefined)?.method === 'POST')
    // The waitFor above guarantees the POST already happened, so this can't be
    // -1 today — asserted explicitly so slice(0, -1) never degrades silently
    // into "drop the last call" if that guarantee ever breaks.
    expect(postIndex).toBeGreaterThan(-1)
    const getsBeforePost = calls
      .slice(0, postIndex)
      .filter(([path, init]) => path === '/notifications' && (init as RequestInit | undefined)?.method === undefined)
    // One, from NotificationsProvider's mount. The panel used to make a second,
    // identical request of its own before marking read — that duplicate is the
    // "Loading…" the visitor saw on every open. The GET that refresh() issues
    // *after* the POST is expected and is deliberately outside this window.
    expect(getsBeforePost).toHaveLength(1)
  })
})

describe('NotificationsSlideOver demo read state', () => {
  afterEach(() => {
    demoState.demoMode = false
    demoState.demoLocked = false
    localStorage.clear()
  })

  // Guards the trap this replaced: the previous version of this test set
  // demoLocked without demoMode, so it kept passing while the demo's real
  // behaviour changed underneath it. On the live demo both flags are true.
  it('still POSTs mark-read on a locked NON-demo tenant', async () => {
    demoState.demoLocked = true
    const { apiFetch } = await import('../lib/api')
    vi.mocked(apiFetch).mockClear()
    renderPanel()
    await screen.findByText('@Board')
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/notifications/mark-read', expect.objectContaining({ method: 'POST' })))
  })

  it('records read state locally instead of POSTing on a demo tenant', async () => {
    demoState.demoMode = true
    demoState.demoLocked = true
    const { apiFetch } = await import('../lib/api')
    vi.mocked(apiFetch).mockClear()
    renderPanel()
    await screen.findByText('@Board')
    const { readMentionIds } = await import('../lib/demoReadState')
    await waitFor(() => expect(readMentionIds()).toEqual(new Set(['m1', 'm2'])))
    expect(apiFetch).not.toHaveBeenCalledWith('/notifications/mark-read', expect.anything())
  })

  // The server sends isUnread: true on every reset, because the reset wipes
  // read_at. The local set is what must win, or the badge re-lights four times
  // a day for mentions this browser has already read.
  it('treats a locally-read mention as read even when the server says unread', async () => {
    demoState.demoMode = true
    localStorage.setItem('floorvote:demo:readMentions', JSON.stringify(['m1']))
    renderPanel()
    const row = (await screen.findByText('@Board')).closest('a') as HTMLElement
    expect(row.style.borderLeft).toContain('transparent')
  })
})
