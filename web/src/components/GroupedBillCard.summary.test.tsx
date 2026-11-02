/**
 * The Feed card's summary preview (#994): the card model carries raw markdown (#992), and
 * the card renders it, folded to 3 lines, with a shared "Show more" that unfolds in place
 * without opening the bill.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'
import { GroupedBillCard } from './GroupedBillCard'
import { groupEventsByBillAndDay, type FeedEvent } from '../lib/feedUtils'

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }))
const navigateMock = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigateMock }
})

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

function ev(billSummary: string | null): FeedEvent {
  return {
    id: 'e', type: 'bill_updated', billId: 'h1', billNumber: 'H 101', billSessionSlug: '2026rs', billState: 'RI',
    billTitle: 'Permit Renewal Act', billSummary, billPriority: 'high', billMatchType: 'keyword', billGroupKey: 'h1',
    userId: 'u', userName: 'Ada', userTitle: null, metadata: { changes: [{ changeType: 'action_added', newValue: 'Passed' }] },
    createdAt: '2026-01-01T10:00:00Z',
  }
}

function renderCard(billSummary: string | null) {
  const [group] = groupEventsByBillAndDay([ev(billSummary)])
  const value = { config: { states: ['RI'] } as AppConfig, multiState: false, loading: false }
  return render(
    <MemoryRouter initialEntries={['/feed']}>
      <ConfigContext.Provider value={value}>
        <GroupedBillCard group={group} />
      </ConfigContext.Provider>
    </MemoryRouter>,
  )
}

const LIST = 'Revises the permit process.\n\n- **Fees**: Lowers a fee.\n- **Forms**: Adds a form.'
const box = (c: HTMLElement) => c.querySelector('[data-fold-state]')!.firstElementChild as HTMLElement

describe('GroupedBillCard: the rendered summary preview', () => {
  it('renders a lead and a bold-label list as markup, with no markdown symbols', () => {
    const { container } = renderCard(LIST)
    expect(container.querySelectorAll('ul > li')).toHaveLength(2)
    expect(container.querySelector('li strong')?.textContent).toBe('Fees')
    expect(container.querySelector('.markdown-summary')!.textContent).not.toContain('*')
  })

  it('renders an HTML-form summary as a list', () => {
    const { container } = renderCard('<p>Lead.</p><ul><li>One</li><li><strong>Two</strong></li></ul>')
    expect(container.querySelectorAll('ul > li')).toHaveLength(2)
    expect(container.querySelector('.markdown-summary')!.textContent).not.toContain('<')
  })

  it('renders a one-line bold-label list as a list', () => {
    const { container } = renderCard('Lead sentence. - **Fees**: Lowers a fee. - **Forms**: Adds a form.')
    expect(container.querySelectorAll('ul > li').length).toBe(2)
  })

  it('renders no summary block when there is none', () => {
    const { container } = renderCard(null)
    expect(container.querySelector('[data-fold-state]')).toBeNull()
    expect(container.textContent).not.toContain('undefined')
    expect(container.textContent).toContain('Permit Renewal Act')
  })

  it('folds to 3 lines of its 1.45 line height, keeping the card\'s summary font and size', () => {
    const { container } = renderCard(LIST)
    const b = box(container)
    expect(b.style.maxHeight).toBe('calc(4.35em)')
    expect(b.style.lineHeight).toBe('1.45')
    expect(b.style.fontSize).toBe('12px')
  })

  it('shows "Show more" when cut off; clicking unfolds in place without opening the bill', () => {
    overflow()
    const { container } = renderCard(LIST)
    const btn = screen.getByRole('button', { name: 'Show more' })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(btn)
    expect(navigateMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
    expect(box(container).style.maxHeight).toBe('')
  })

  it('does not open the bill on a middle click of the toggle either', () => {
    overflow()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    renderCard(LIST)
    fireEvent(screen.getByRole('button', { name: 'Show more' }), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(open).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('is operable by keyboard without navigating', async () => {
    overflow()
    renderCard(LIST)
    const user = userEvent.setup()
    screen.getByRole('button', { name: 'Show more' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard(' ')
    expect(screen.getByRole('button', { name: 'Show more' })).toHaveAttribute('aria-expanded', 'false')
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('renders no toggle when the summary fits', () => {
    renderCard(LIST)
    expect(screen.queryByRole('button', { name: /show (more|less)/i })).toBeNull()
  })

  it('still opens the bill when the summary text is clicked', () => {
    const { container } = renderCard(LIST)
    fireEvent.click(container.querySelector('li') as HTMLElement)
    expect(navigateMock).toHaveBeenCalledWith('/RI/2026rs/H 101')
  })
})
