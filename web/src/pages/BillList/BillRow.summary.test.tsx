/**
 * The bill list row's summary preview (#994): the summary renders as markdown, folded to
 * 4 lines, and a cut-off one unfolds in place behind the shared "Show more" toggle. The
 * abstract fallback folds the same way as plain text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillRow } from './BillRow'
import type { Bill } from './types'

const navigateMock = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigateMock }
})
vi.mock('../../context/ConfigContext', () => ({
  useConfig: () => ({ config: null, multiState: false, loading: false }),
  useMultiState: () => false,
}))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false }),
}))

// jsdom does no layout: scrollHeight/clientHeight decide whether the folded preview is cut off.
const dims = { scrollHeight: 0, clientHeight: 0 }
let spies: Array<{ mockRestore: () => void }>
beforeEach(() => {
  Object.assign(dims, { scrollHeight: 0, clientHeight: 0 })
  spies = [
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => dims.scrollHeight),
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => dims.clientHeight),
  ]
})
afterEach(() => { spies.forEach(s => s.mockRestore()); navigateMock.mockClear() })
const overflow = () => { dims.scrollHeight = 120; dims.clientHeight = 56 }

function makeBill(over: Partial<Bill> = {}): Bill {
  return {
    id: 'b1', billNumber: 'HB 1', title: 'Permit Renewal Act', state: 'RI', status: '2',
    session: '2025-2026', sessionSlug: '2025-2026', sessionId: null, yearStart: 2025, yearEnd: 2026,
    abstract: null, url: null, stateUrl: null, lastAction: null,
    lastActionDate: '2026-02-01', tenantSummary: null, tags: [], priority: null,
    matchType: null, isDraft: false, position: null, relevanceScore: null,
    aiProcessedAt: null, newMatchAt: null, triagedAt: null,
    voteCounts: { support: 0, oppose: 0, neutral: 0 }, myVote: null,
    commentCount: 0, hasNote: false, hasComment: false, updatedAt: '2026-02-01 10:00:00',
    customFieldValues: {},
    ...over,
  }
}

function renderRow(bill: Partial<Bill>) {
  return render(
    <MemoryRouter>
      <BillRow
        bill={makeBill(bill)}
        index={0}
        onTagClick={vi.fn()}
        isAdmin={false}
        positionVocabulary={['Support', 'Oppose']}
        onStatusClick={vi.fn()}
        onPriorityClick={vi.fn()}
        onPositionClick={vi.fn()}
        onRelevanceClick={vi.fn()}
        onPriorityChange={vi.fn()}
        onPositionChange={vi.fn()}
        onVote={undefined}
        onToggleSelect={undefined}
        filter={{ status: [], priority: [], position: [], year: [], minRelevance: 0, tag: [] }}
        sortedPaths={[]}
        isMultiState={false}
        isSelectionMode={false}
        isSelected={false}
      />
    </MemoryRouter>,
  )
}

const LIST = 'Revises the permit process.\n\n- **Fees**: Lowers a fee.\n- **Forms**: Adds a form.'

describe('BillRow: the rendered summary preview', () => {
  it('renders a lead and a list as <ul>/<li> markup, not flattened text', () => {
    const { container } = renderRow({ tenantSummary: LIST })
    expect(container.querySelectorAll('.bill-row ul > li')).toHaveLength(2)
    expect(container.querySelector('.bill-row li strong')?.textContent).toBe('Fees')
    expect(container.querySelector('.markdown-summary')!.textContent).not.toContain('**')
  })

  it('renders an HTML-form summary as a list', () => {
    const { container } = renderRow({ tenantSummary: '<p>Lead.</p><ul><li>One</li><li>Two</li></ul>' })
    expect(container.querySelectorAll('.bill-row ul > li')).toHaveLength(2)
  })

  it('renders a one-line bold-label summary as a list', () => {
    const { container } = renderRow({ tenantSummary: 'Lead sentence. - **Fees**: Lowers a fee. - **Forms**: Adds a form.' })
    expect(container.querySelectorAll('.bill-row ul > li').length).toBe(2)
  })

  it('folds the preview to 4 lines of the row\'s 1.4 line height, keeping its serif size and color', () => {
    const { container } = renderRow({ tenantSummary: LIST })
    const box = container.querySelector('[data-fold-state]')!.firstElementChild as HTMLElement
    expect(box.style.maxHeight).toBe('calc(5.6em)')
    expect(box.style.lineHeight).toBe('1.4')
    expect(box.style.fontFamily).toContain('Source Serif 4')
    expect(box.style.fontSize).toBe('12px')
  })

  it('shows "Show more" when cut off; clicking unfolds in place and the row\'s link is not followed', () => {
    overflow()
    const { container } = renderRow({ tenantSummary: LIST })
    const btn = screen.getByRole('button', { name: 'Show more' })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(btn)
    expect(navigateMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
    const box = container.querySelector('[data-fold-state]')!.firstElementChild as HTMLElement
    expect(box.style.maxHeight).toBe('')
  })

  it('does not open the bill on the toggle press, or on a middle click of it', () => {
    overflow()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    renderRow({ tenantSummary: LIST })
    const btn = screen.getByRole('button', { name: 'Show more' })
    fireEvent.mouseDown(btn)
    fireEvent.click(btn)
    fireEvent(btn, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(navigateMock).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('is reachable and operable by keyboard without navigating', async () => {
    overflow()
    renderRow({ tenantSummary: LIST })
    const user = userEvent.setup()
    screen.getByRole('button', { name: 'Show more' }).focus()
    expect(screen.getByRole('button', { name: 'Show more' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard(' ')
    expect(screen.getByRole('button', { name: 'Show more' })).toHaveAttribute('aria-expanded', 'false')
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('renders no toggle when the summary fits', () => {
    renderRow({ tenantSummary: LIST })
    expect(screen.queryByRole('button', { name: /show (more|less)/i })).toBeNull()
  })

  it('still opens the bill when the preview text itself is clicked', () => {
    const { container } = renderRow({ tenantSummary: LIST })
    fireEvent.click(container.querySelector('.bill-row li') as HTMLElement)
    expect(navigateMock).toHaveBeenCalledWith('/RI/2025-2026/HB 1', expect.anything())
  })

  it('renders no preview when there is no summary and no distinct abstract', () => {
    const { container } = renderRow({ tenantSummary: null, abstract: null })
    expect(container.querySelector('[data-fold-state]')).toBeNull()
  })

  it('renders no preview for a blank summary', () => {
    const { container } = renderRow({ tenantSummary: '   ', abstract: null })
    expect(container.querySelector('[data-fold-state]')).toBeNull()
  })

  it('does not preview an abstract that just repeats the title', () => {
    const { container } = renderRow({ tenantSummary: null, abstract: 'permit renewal act' })
    expect(container.querySelector('[data-fold-state]')).toBeNull()
  })
})

describe('BillRow: the gap after the fold', () => {
  const ABSTRACT = 'Relates to permit renewal timelines for licensed operators.'
  const wrapper = (c: HTMLElement) => c.querySelector('[data-fold-state]')!.parentElement as HTMLElement

  it('is 10px before the tag chips, at least twice the 1px the toggle sits under the text', () => {
    const { container } = renderRow({ tenantSummary: LIST, tags: ['Alpha'] })
    expect(wrapper(container).style.marginBottom).toBe('10px')
  })

  it('is 10px before the tag chips after an abstract fold too', () => {
    const { container } = renderRow({ tenantSummary: null, abstract: ABSTRACT, tags: ['Alpha'] })
    expect(wrapper(container).style.marginBottom).toBe('10px')
  })

  it('stays 5px when no tags follow, so the row does not gain empty space above its padding', () => {
    expect(wrapper(renderRow({ tenantSummary: LIST, tags: [] }).container).style.marginBottom).toBe('5px')
    expect(wrapper(renderRow({ tenantSummary: null, abstract: ABSTRACT, tags: [] }).container).style.marginBottom).toBe('5px')
  })
})

describe('BillRow: the abstract fallback preview', () => {
  const ABSTRACT = 'Relates to permit renewal timelines for licensed operators.'

  it('shows a distinct abstract as plain text, with no list markup', () => {
    const { container } = renderRow({ tenantSummary: null, abstract: ABSTRACT })
    const box = container.querySelector('[data-fold-state]')!.firstElementChild as HTMLElement
    expect(box.textContent).toBe(ABSTRACT)
    expect(box.querySelector('ul, li, p')).toBeNull()
  })

  it('folds the abstract at 4 lines, with the same toggle', () => {
    overflow()
    const { container } = renderRow({ tenantSummary: null, abstract: ABSTRACT })
    const box = container.querySelector('[data-fold-state]')!.firstElementChild as HTMLElement
    expect(box.style.webkitLineClamp || box.style.getPropertyValue('-webkit-line-clamp')).toBe('4')
    const btn = screen.getByRole('button', { name: 'Show more' })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(btn)
    expect(navigateMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
    expect(box.style.webkitLineClamp || box.style.getPropertyValue('-webkit-line-clamp')).toBe('')
  })

  it('renders no toggle when the abstract fits', () => {
    renderRow({ tenantSummary: null, abstract: ABSTRACT })
    expect(screen.queryByRole('button', { name: /show (more|less)/i })).toBeNull()
  })

  it('falls through to a distinct abstract when the summary is only whitespace', () => {
    const { container } = renderRow({ tenantSummary: '   ', abstract: ABSTRACT })
    const box = container.querySelector('[data-fold-state]')!.firstElementChild as HTMLElement
    expect(box.textContent).toBe(ABSTRACT)
    expect(box.style.webkitLineClamp || box.style.getPropertyValue('-webkit-line-clamp')).toBe('4')
  })

  it('prefers the summary over the abstract', () => {
    const { container } = renderRow({ tenantSummary: LIST, abstract: ABSTRACT })
    expect(container.querySelector('.markdown-summary')!.textContent).not.toContain(ABSTRACT)
  })
})
