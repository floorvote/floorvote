import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { CommitteeFilterDropdown } from './CommitteeFilter'
import { SubjectFilterDropdown } from './FilterPanel'
import { committeeGroups, type CommitteeGroup } from '../../lib/committeeGroups'
import { color } from '../../styles/tokens'

// The Committee menu (#471): each committee with its count, under its state, in the order `committeeGroups` gives,
// and a switch between the committee a bill is in now and any committee it was referred to.

// The option list is virtualized, and jsdom does no layout: stub the scroll container's height so the real
// virtualizer computes a real, bounded range (as FilterPanel.test.tsx does for the subject list).
let restoreViewportHeight: (() => void) | undefined
beforeAll(() => {
  const props = ['clientHeight', 'offsetHeight'] as const
  const descriptors = props.map(prop => Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop))
  for (const prop of props) Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value: 600 })
  restoreViewportHeight = () => {
    props.forEach((prop, i) => {
      const descriptor = descriptors[i]
      if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor)
    })
  }
})
afterAll(() => { restoreViewportHeight?.() })

/** `{ NJ: 3 }` is three committees, Committee 0 to Committee 2, counted high to low. */
function makeGroups(spec: Record<string, number>): CommitteeGroup[] {
  return Object.entries(spec).map(([state, n]) => ({
    state,
    options: Array.from({ length: n }, (_, i) => ({ value: `${state}-${i}`, label: `Committee ${i}`, count: n - i })),
  }))
}

const GROUPS: CommitteeGroup[] = [
  { state: 'NJ', options: [
    { value: '101', label: 'Judiciary (Senate)', count: 12 },
    { value: '102', label: 'Rules (Senate)', count: 140 },
  ] },
  { state: 'TX', options: [{ value: '201', label: 'State Affairs (House)', count: 4 }] },
]

const INFO = {
  101: { name: 'Judiciary', state: 'NJ', chamber: 'S' },
  102: { name: 'Rules', state: 'NJ', chamber: 'S' },
  103: { name: 'Calendars', state: 'NJ', chamber: 'H' },
}

function renderMenu(props: Partial<Parameters<typeof CommitteeFilterDropdown>[0]> = {}) {
  const onChange = vi.fn()
  const onScopeChange = vi.fn()
  render(<CommitteeFilterDropdown groups={GROUPS} selected={[]} onChange={onChange} scope="any" onScopeChange={onScopeChange} showStates {...props} />)
  fireEvent.click(screen.getByRole('button', { name: /^Committee/ }))
  return { onChange, onScopeChange, menu: screen.getByRole('group', { name: 'Committee' }) }
}

describe('the Committee menu', () => {
  it('lists each committee with its count, under its state', () => {
    const { menu } = renderMenu()
    expect(within(menu).getByText('NJ')).toBeInTheDocument()
    expect(within(menu).getByText('TX')).toBeInTheDocument()
    const judiciary = within(menu).getByRole('checkbox', { name: /Judiciary \(Senate\)/ }).closest('label')!
    expect(within(judiciary).getByText('12')).toBeInTheDocument()
  })

  it('renders no Procedural tag beside a Rules committee', () => {
    const { menu } = renderMenu({ groups: committeeGroups({ 101: 12, 102: 140, 103: 3 }, INFO) })
    expect(within(menu).queryByText('Procedural')).toBeNull()
    expect(menu.textContent).not.toMatch(/Procedural/)
  })

  it('lists a large Rules committee first, by its count, with nothing after its name but the count', () => {
    const { menu } = renderMenu({ groups: committeeGroups({ 101: 12, 102: 140, 103: 3 }, INFO) })
    const labels = within(menu).getAllByRole('checkbox').map(c => c.closest('label')!.textContent)
    expect(labels).toEqual(['Rules (Senate)140', 'Judiciary (Senate)12', 'Calendars (House)3'])
  })

  it('picks a committee', () => {
    const { menu, onChange } = renderMenu({ selected: ['201'] })
    fireEvent.click(within(menu).getByRole('checkbox', { name: /Judiciary/ }))
    expect(onChange).toHaveBeenCalledWith(['201', '101'])
  })

  it('switches between the current committee and any referral', () => {
    const { menu, onScopeChange } = renderMenu()
    expect(within(menu).getByRole('radio', { name: 'Any referral' })).toBeChecked()
    fireEvent.click(within(menu).getByRole('radio', { name: 'Current committee' }))
    expect(onScopeChange).toHaveBeenCalledWith('current')
  })

  it('leaves out the state headings on a single-state instance', () => {
    const { menu } = renderMenu({ groups: [GROUPS[0]], showStates: false })
    expect(within(menu).queryByText('NJ')).toBeNull()
  })

  it('says how many committees are picked on its button', () => {
    render(<CommitteeFilterDropdown groups={GROUPS} selected={['101', '201']} onChange={() => {}} scope="any" onScopeChange={() => {}} showStates />)
    expect(screen.getByRole('button', { name: 'Committee (2)' })).toBeInTheDocument()
  })
})

const SEARCH = /search committees/i

describe('the Committee menu looks like the Subject menu', () => {
  it('ends where the options end, with no padded bar below them', () => {
    const { menu } = renderMenu()
    const end = menu.lastElementChild as HTMLElement
    expect(menu.style.padding).toBe('')
    expect(end.style.overflowY).toBe('auto')
    expect(end.style.background).not.toBe(color.surfaceMuted)
  })

  it('has the same outer chrome as the Subject menu', () => {
    const { unmount } = render(<SubjectFilterDropdown subjectGroups={[{ state: 'NJ', options: [{ value: 'NJ:Roads', label: 'Roads', count: 1 }] }]} selectedSubjects={[]} onSubjectChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /^Subject/ }))
    const subjectMenu = screen.getByRole('group', { name: /^Subject/ })
    const subjectEnd = subjectMenu.lastElementChild as HTMLElement
    const subject = { padding: subjectMenu.style.padding, display: subjectMenu.style.display, flexDirection: subjectMenu.style.flexDirection, endOverflow: subjectEnd.style.overflowY }
    unmount()
    const { menu } = renderMenu()
    const end = menu.lastElementChild as HTMLElement
    expect({ padding: menu.style.padding, display: menu.style.display, flexDirection: menu.style.flexDirection, endOverflow: end.style.overflowY }).toEqual(subject)
  })

  it('gives the scope radios the gray of the state headers', () => {
    const { menu } = renderMenu()
    const radios = within(menu).getByRole('radiogroup')
    const header = within(menu).getByText('NJ')
    expect(radios.style.background).toBe(color.surfaceMuted)
    expect(radios.style.background).toBe(header.style.background)
  })

  it('gives the scope radios that gray on a single-state instance too', () => {
    const { menu } = renderMenu({ groups: [GROUPS[0]], showStates: false })
    expect(within(menu).getByRole('radiogroup').style.background).toBe(color.surfaceMuted)
  })
})

describe('the Committee menu search', () => {
  it('has a search box above the committees', () => {
    const { menu } = renderMenu()
    const search = within(menu).getByPlaceholderText(SEARCH)
    const firstBox = within(menu).getAllByRole('checkbox')[0]
    expect(search.compareDocumentPosition(firstBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('narrows committees by name, ignoring case', () => {
    const { menu } = renderMenu()
    fireEvent.change(within(menu).getByPlaceholderText(SEARCH), { target: { value: 'JUDI' } })
    expect(within(menu).getByRole('checkbox', { name: /Judiciary/ })).toBeInTheDocument()
    expect(within(menu).queryByRole('checkbox', { name: /Rules/ })).toBeNull()
    expect(within(menu).queryByRole('checkbox', { name: /State Affairs/ })).toBeNull()
  })

  it('drops the state headings once one state is left', () => {
    const { menu } = renderMenu()
    expect(within(menu).getByText('NJ')).toBeInTheDocument()
    expect(within(menu).getByText('TX')).toBeInTheDocument()
    fireEvent.change(within(menu).getByPlaceholderText(SEARCH), { target: { value: 'affairs' } })
    expect(within(menu).queryByText('NJ')).toBeNull()
    expect(within(menu).queryByText('TX')).toBeNull()
    fireEvent.change(within(menu).getByPlaceholderText(SEARCH), { target: { value: 'e' } })
    expect(within(menu).getByText('NJ')).toBeInTheDocument()
    expect(within(menu).getByText('TX')).toBeInTheDocument()
  })

  it('says so when nothing matches, and keeps the scope switch', () => {
    const { menu } = renderMenu()
    fireEvent.change(within(menu).getByPlaceholderText(SEARCH), { target: { value: 'zzz-no-match' } })
    expect(within(menu).queryAllByRole('checkbox')).toHaveLength(0)
    expect(within(menu).getByText(/no committees match/i)).toBeInTheDocument()
    expect(within(menu).getByRole('radio', { name: 'Any referral' })).toBeInTheDocument()
  })

  it('brings every committee back when the search is cleared', () => {
    const { menu } = renderMenu()
    const box = within(menu).getByPlaceholderText(SEARCH)
    fireEvent.change(box, { target: { value: 'rules' } })
    expect(within(menu).getAllByRole('checkbox')).toHaveLength(1)
    fireEvent.change(box, { target: { value: '' } })
    expect(within(menu).getAllByRole('checkbox')).toHaveLength(3)
  })

  it('picks a committee found by search, keeping what was already picked', () => {
    const { menu, onChange } = renderMenu({ selected: ['201'] })
    fireEvent.change(within(menu).getByPlaceholderText(SEARCH), { target: { value: 'rules' } })
    fireEvent.click(within(menu).getByRole('checkbox', { name: /Rules/ }))
    expect(onChange).toHaveBeenCalledWith(['201', '102'])
  })

  it('keeps a picked committee picked while the search hides it', () => {
    const groups = makeGroups({ NJ: 3 })
    const props = { groups, selected: ['NJ-1'], onChange: () => {}, scope: 'any' as const, onScopeChange: () => {}, showStates: false }
    render(<CommitteeFilterDropdown {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /^Committee/ }))
    const box = screen.getByPlaceholderText(SEARCH)
    fireEvent.change(box, { target: { value: 'Committee 2' } })
    expect(screen.queryByRole('checkbox', { name: /Committee 1/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Committee (1)' })).toBeInTheDocument()
    fireEvent.change(box, { target: { value: '' } })
    expect(screen.getByRole('checkbox', { name: /Committee 1/ })).toBeChecked()
  })

  it('finds a picked committee that has no bills left, at zero', () => {
    const { menu } = renderMenu({ groups: [{ state: 'NJ', options: [{ value: '1', label: 'Agriculture (Senate)', count: 0 }] }], selected: ['1'] })
    fireEvent.change(within(menu).getByPlaceholderText(SEARCH), { target: { value: 'agri' } })
    const box = within(menu).getByRole('checkbox', { name: /Agriculture/ })
    expect(box).toBeChecked()
    expect(within(box.closest('label')!).getByText('0')).toBeInTheDocument()
  })

  it('does not change the picks or the scope just by searching', () => {
    const { menu, onChange, onScopeChange } = renderMenu({ selected: ['101'] })
    fireEvent.change(within(menu).getByPlaceholderText(SEARCH), { target: { value: 'ru' } })
    expect(onChange).not.toHaveBeenCalled()
    expect(onScopeChange).not.toHaveBeenCalled()
  })
})

describe('the Committee menu with many committees', () => {
  it('renders only the committees near the viewport', () => {
    const { menu } = renderMenu({ groups: makeGroups({ NJ: 500, TX: 500 }) })
    const boxes = within(menu).getAllByRole('checkbox')
    expect(boxes.length).toBeGreaterThan(0)
    expect(boxes.length).toBeLessThan(100)
  })

  it('truncates a long name to one line, with the full name on hover', () => {
    const long = 'Government Operations and Administrative Rulemaking Oversight (Senate)'
    const { menu } = renderMenu({ groups: [{ state: 'NJ', options: [{ value: '1', label: long, count: 9 }] }] })
    const name = within(menu).getByText(long)
    expect(name.style.whiteSpace).toBe('nowrap')
    expect(name.style.textOverflow).toBe('ellipsis')
    expect(name).toHaveAttribute('title', long)
    expect(within(menu).getByText('9')).toBeInTheDocument()
  })

  it('pins the first state header at the top, then the next state header once the list scrolls to it', () => {
    const { menu } = renderMenu({ groups: makeGroups({ NJ: 40, TX: 40 }) })
    const wrapperOf = (label: string) => within(menu).getByText(label).parentElement as HTMLElement
    const list = within(menu).getByTestId('committee-options')
    // jsdom has no ResizeObserver to re-render once the list is measured, so a scroll to the top does.
    fireEvent.scroll(list)
    expect(wrapperOf('NJ').style.position).toBe('sticky')
    // Forty NJ rows of 28px sit under NJ's 24px header, so TX's header starts at 24 + 40 * 28.
    list.scrollTop = 24 + 40 * 28 + 100
    // The shared hook learns which header is pinned while rendering the rows, so the pin lands on the render after the
    // first scroll one (scrolling renders continuously in a browser): scroll a few rows further.
    fireEvent.scroll(list)
    list.scrollTop += 3 * 28
    fireEvent.scroll(list)
    expect(wrapperOf('TX').style.position).toBe('sticky')
    expect(within(menu).queryByText('NJ')).toBeNull()
  })
})

describe('the Committee menu keyboard', () => {
  const focused = () => document.activeElement as HTMLInputElement
  /** A committee row's full name, from its title (the label's text runs on into the count). */
  const nameOf = (box: HTMLElement) => box.closest('label')!.querySelector('[title]')!.getAttribute('title') ?? ''

  it('opens with the checked scope radio focused', () => {
    renderMenu()
    expect(focused()).toBe(screen.getByRole('radio', { name: 'Any referral' }))
  })

  it('walks down from the scope radios through the committees, then wraps to the radios', () => {
    const { menu } = renderMenu()
    fireEvent.keyDown(focused(), { key: 'ArrowDown' })
    expect(focused()).toBe(within(menu).getByRole('checkbox', { name: /Judiciary/ }))
    fireEvent.keyDown(focused(), { key: 'ArrowDown' })
    expect(focused()).toBe(within(menu).getByRole('checkbox', { name: /Rules/ }))
    fireEvent.keyDown(focused(), { key: 'ArrowDown' })
    expect(focused()).toBe(within(menu).getByRole('checkbox', { name: /State Affairs/ }))
    fireEvent.keyDown(focused(), { key: 'ArrowDown' })
    expect(focused()).toBe(within(menu).getByRole('radio', { name: 'Current committee' }))
  })

  it('walks up from the first radio to the last committee', () => {
    const { menu } = renderMenu()
    within(menu).getByRole('radio', { name: 'Current committee' }).focus()
    fireEvent.keyDown(focused(), { key: 'ArrowUp' })
    expect(focused()).toBe(within(menu).getByRole('checkbox', { name: /State Affairs/ }))
    fireEvent.keyDown(focused(), { key: 'ArrowUp' })
    expect(focused()).toBe(within(menu).getByRole('checkbox', { name: /Rules/ }))
  })

  it('goes from the search box to the first radio on ArrowDown, and to the last committee on ArrowUp', () => {
    const { menu } = renderMenu()
    const search = within(menu).getByPlaceholderText(SEARCH)
    search.focus()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(focused()).toBe(within(menu).getByRole('radio', { name: 'Current committee' }))
    search.focus()
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(focused()).toBe(within(menu).getByRole('checkbox', { name: /State Affairs/ }))
  })

  it('walks only the committees the search leaves', () => {
    const { menu } = renderMenu()
    fireEvent.change(within(menu).getByPlaceholderText(SEARCH), { target: { value: 'rules' } })
    within(menu).getByRole('radio', { name: 'Any referral' }).focus()
    fireEvent.keyDown(focused(), { key: 'ArrowDown' })
    expect(focused()).toBe(within(menu).getByRole('checkbox', { name: /Rules/ }))
    fireEvent.keyDown(focused(), { key: 'ArrowDown' })
    expect(focused()).toBe(within(menu).getByRole('radio', { name: 'Current committee' }))
  })

  it('reaches the next committee past the last rendered row, scrolling it into view', () => {
    const { menu } = renderMenu({ groups: makeGroups({ NJ: 200 }), showStates: false })
    const list = within(menu).getByTestId('committee-options')
    const boxes = within(menu).getAllByRole('checkbox')
    const lastRendered = boxes[boxes.length - 1]
    const n = Number(nameOf(lastRendered).replace('Committee ', ''))
    expect(n).toBeLessThan(150)
    lastRendered.focus()
    fireEvent.keyDown(lastRendered, { key: 'ArrowDown' })
    fireEvent.scroll(list)
    expect(nameOf(focused())).toBe(`Committee ${n + 1}`)
  })

  it('reaches the last of many committees from the first radio, scrolling to it', () => {
    const { menu } = renderMenu({ groups: makeGroups({ NJ: 200 }), showStates: false })
    const list = within(menu).getByTestId('committee-options')
    within(menu).getByRole('radio', { name: 'Current committee' }).focus()
    fireEvent.keyDown(focused(), { key: 'ArrowUp' })
    fireEvent.scroll(list)
    expect(list.scrollTop).toBeGreaterThan(0)
    expect(nameOf(focused())).toBe('Committee 199')
  })

  it('closes on Escape from the search box and returns focus to the button', () => {
    const { menu } = renderMenu()
    const search = within(menu).getByPlaceholderText(SEARCH)
    search.focus()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Committee' })).toBeNull()
    expect(focused()).toBe(screen.getByRole('button', { name: /^Committee/ }))
  })
})
