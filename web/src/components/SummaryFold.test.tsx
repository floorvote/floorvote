import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SummaryFold } from './SummaryFold'

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
afterEach(() => { spies.forEach(s => s.mockRestore()) })
const overflow = () => { dims.scrollHeight = 120; dims.clientHeight = 56 }

const LIST = 'Revises the permit process.\n\n- **Fees**: Lowers a fee.\n- **Forms**: Adds a form.'
const view = (md: string, over: Record<string, unknown> = {}) => render(
  <SummaryFold markdown={md} lines={4} lineHeight={1.4} fontSize={13} wrapperStyle={{ marginBottom: 5 }} {...over} />,
)
const preview = (c: HTMLElement) => c.querySelector('[data-fold-state]')!.firstElementChild as HTMLElement

describe('SummaryFold: what it renders', () => {
  it('renders a lead and a list as markup, with the bold labels as <strong>', () => {
    const { container } = view(LIST)
    expect(container.querySelectorAll('ul > li')).toHaveLength(2)
    expect(container.querySelector('p')?.textContent).toBe('Revises the permit process.')
    expect(container.querySelector('li strong')?.textContent).toBe('Fees')
    expect(container.querySelector('.markdown-summary')!.textContent).not.toContain('*')
  })

  it('renders an HTML-form summary as a list, like the bill page does', () => {
    const { container } = view('<p>Lead.</p><ul><li>One</li><li><strong>Two</strong></li></ul>')
    expect(container.querySelectorAll('ul > li')).toHaveLength(2)
    expect(container.querySelector('.markdown-summary')!.textContent).not.toContain('<')
  })

  it('renders a one-line bold-label list as a list', () => {
    const { container } = view('Lead sentence. - **Fees**: Lowers a fee. - **Forms**: Adds a form.')
    expect(container.querySelectorAll('ul > li').length).toBe(2)
  })

  it('renders nothing for an empty or blank summary', () => {
    expect(view('').container).toBeEmptyDOMElement()
    expect(view('  \n ').container).toBeEmptyDOMElement()
  })

  it('keeps the surface typography on the preview', () => {
    const { container } = view(LIST, { fontFamily: 'Georgia, serif', color: 'rgb(1, 2, 3)' })
    const box = preview(container)
    expect(box.style.fontSize).toBe('13px')
    expect(box.style.lineHeight).toBe('1.4')
    expect(box.style.fontFamily).toContain('Georgia')
    expect(box.style.color).toBe('rgb(1, 2, 3)')
  })
})

describe('SummaryFold: the fold', () => {
  it('clips to the given number of lines of its own line height, not a flat clamp', () => {
    const { container } = view(LIST, { lines: 4, lineHeight: 1.4 })
    const box = preview(container)
    expect(box.style.maxHeight).toBe('calc(5.6em)')
    expect(box.style.overflow).toBe('hidden')
    expect(box.style.webkitLineClamp || box.style.getPropertyValue('-webkit-line-clamp')).toBe('')
  })

  it('clips 3 lines at 1.45 for the Feed', () => {
    const { container } = view(LIST, { lines: 3, lineHeight: 1.45 })
    expect(preview(container).style.maxHeight).toBe('calc(4.35em)')
  })

  it('shows "Show more" with aria-expanded=false when cut off, and a fade on the preview', () => {
    overflow()
    const { container } = view(LIST)
    const btn = screen.getByRole('button', { name: 'Show more' })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    expect(preview(container)).toHaveAttribute('data-fold-fade')
  })

  it('unfolds in place on click: relabels, reports aria-expanded, drops the clip and the fade', () => {
    overflow()
    const { container } = view(LIST)
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    const btn = screen.getByRole('button', { name: 'Show less' })
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    const box = preview(container)
    expect(box.style.maxHeight).toBe('')
    expect(box).not.toHaveAttribute('data-fold-fade')
    expect(container.querySelectorAll('li')).toHaveLength(2)
  })

  it('renders no toggle and no fade when the summary fits', () => {
    const { container } = view(LIST)
    expect(screen.queryByRole('button')).toBeNull()
    expect(preview(container)).not.toHaveAttribute('data-fold-fade')
  })

  it('does not count a trailing margin on the last block, or the last list item, as overflow', () => {
    // A summary that exactly fits must not grow a toggle and a fade because the last
    // <li> carries the list's 2px item margin.
    const { container } = view(LIST)
    const lastLi = container.querySelectorAll('li')[1]
    expect(getComputedStyle(lastLi).marginBottom).toBe('0px')
    expect(getComputedStyle(container.querySelector('ul')!).marginBottom).toBe('0px')
    // Items between others keep their spacing.
    expect(getComputedStyle(container.querySelectorAll('li')[0]).marginBottom).toBe('2px')
  })

  it('zeroes the trailing margin of nested last items and of a last paragraph', () => {
    const { container } = view('- Outer\n  - Inner one\n  - Inner two')
    const lis = container.querySelectorAll('li')
    expect(getComputedStyle(lis[lis.length - 1]).marginBottom).toBe('0px')
    expect(getComputedStyle(container.querySelector('li')!).marginBottom).toBe('0px')
    const prose = view('Only a lead sentence.').container
    expect(getComputedStyle(prose.querySelector('p')!).marginBottom).toBe('0px')
  })

  it('puts spacing on the wrapper and none on the clipped preview or the clip box', () => {
    const { container } = view(LIST)
    const clip = container.querySelector('[data-fold-state]') as HTMLElement
    expect((clip.parentElement as HTMLElement).style.marginBottom).toBe('5px')
    for (const el of [clip, preview(container)]) {
      expect(el.style.marginTop).toBe('')
      expect(el.style.marginBottom).toBe('')
      expect(el.style.margin).toBe('')
    }
  })

  it('opens with the keyboard, Enter and Space, and does not click through to a parent', async () => {
    overflow()
    const onParent = vi.fn()
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    render(<div onClick={onParent}><SummaryFold markdown={LIST} lines={4} lineHeight={1.4} /></div>)
    const user = userEvent.setup()
    screen.getByRole('button', { name: 'Show more' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard(' ')
    expect(screen.getByRole('button', { name: 'Show more' })).toHaveAttribute('aria-expanded', 'false')
    expect(onParent).not.toHaveBeenCalled()
  })
})
