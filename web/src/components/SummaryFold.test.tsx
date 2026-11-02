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

  // jsdom resolves a computed style by sheet order, not specificity, so these ask the
  // sheet which elements its trailing-margin rules reach instead.
  const sheetSelectors = () => {
    const css = [...document.querySelectorAll('style')].map(s => s.textContent ?? '').filter(t => t.includes('summary-fold')).join('\n')
    return [...css.matchAll(/([^{}]+)\{[^}]*margin-bottom:\s*0/g)].flatMap(m => m[1].split(/,(?![^(]*\))/).map(x => x.trim()))
  }
  const zeroed = (el: Element) => sheetSelectors().some(sel => el.matches(sel))

  it('zeroes the trailing margin of the last list item, and keeps the spacing between items', () => {
    const { container } = view(LIST)
    const [first, last] = Array.from(container.querySelectorAll('li'))
    expect(zeroed(last)).toBe(true)
    expect(zeroed(first)).toBe(false)
  })

  it('reaches the last item of a nested list at the end, and not the nested items that are not last', () => {
    const { container } = view('- Outer\n  - Inner one\n  - Inner two\n- Tail')
    const lis = Array.from(container.querySelectorAll('li'))
    const byText = (t: string) => lis.find(li => li.firstChild?.textContent?.trim() === t)!
    expect(zeroed(byText('Tail'))).toBe(true)
    expect(zeroed(byText('Outer'))).toBe(false)
    expect(zeroed(byText('Inner one'))).toBe(false)
    expect(zeroed(byText('Inner two'))).toBe(false)
  })

  it('reaches a nested list that ends the content', () => {
    const { container } = view('- Outer\n  - Inner one\n  - Inner two')
    const lis = Array.from(container.querySelectorAll('li'))
    expect(zeroed(lis[lis.length - 1])).toBe(true)
    expect(zeroed(lis[0])).toBe(true)
  })

  it('leaves a list that is not the last block alone, and a paragraph after a list needs no rule', () => {
    const { container } = view('Lead.\n\n- One\n- Two\n\nClosing sentence.')
    for (const li of Array.from(container.querySelectorAll('li'))) expect(zeroed(li)).toBe(false)
    expect(getComputedStyle(container.querySelector('.markdown-summary > p:last-child')!).marginBottom).toBe('0px')
  })

  it('reaches the paragraph inside the last item of a loose list', () => {
    const { container } = view('- One\n\n- Two\n\n- Three')
    const ps = Array.from(container.querySelectorAll('li > p'))
    expect(ps).toHaveLength(3)
    expect(zeroed(ps[2])).toBe(true)
    expect(zeroed(ps[0])).toBe(false)
  })

  it('reaches the last paragraph of a blockquote that ends the content', () => {
    const { container } = view('Lead.\n\n> First quoted.\n>\n> Last quoted.')
    const ps = Array.from(container.querySelectorAll('blockquote > p'))
    expect(ps).toHaveLength(2)
    expect(zeroed(ps[1])).toBe(true)
    expect(zeroed(ps[0])).toBe(false)
  })

  it('shares one sheet across any number of folds', () => {
    render(<><SummaryFold markdown={LIST} lines={4} lineHeight={1.4} /><SummaryFold markdown={LIST} lines={4} lineHeight={1.4} /><SummaryFold markdown={LIST} lines={4} lineHeight={1.4} /></>)
    const sheets = [...document.querySelectorAll('style')].filter(s => (s.textContent ?? '').includes('summary-fold'))
    expect(sheets).toHaveLength(1)
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
