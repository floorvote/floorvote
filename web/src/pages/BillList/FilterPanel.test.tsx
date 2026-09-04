import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { FilterDropdown, ActiveChip, FILTER_ANY, SubjectFilterDropdown, SubjectExclusionNotice, type SubjectGroup } from './FilterPanel'

function renderPanel(props: Partial<ComponentProps<typeof SubjectFilterDropdown>> = {}) {
  const defaults: ComponentProps<typeof SubjectFilterDropdown> = {
    subjectGroups: [{ state: 'UT', options: [{ value: 'UT:Counties', label: 'Counties', count: 2 }] }],
    selectedSubjects: [],
    onSubjectChange: () => {},
  }
  return render(<SubjectFilterDropdown {...defaults} {...props} />)
}

// SubjectFilterDropdown's option list is virtualized (@tanstack/react-virtual):
// with staging heading toward ~13k subject terms, an unvirtualized list hangs
// the UI. jsdom performs no layout, so the scroll container's real offsetHeight
// is 0 and the virtualizer would compute a 0-row viewport and render nothing —
// not just for the large synthetic lists below, but for every existing small
// list in this describe block too. Rather than mocking the virtualizer away
// (which would make it impossible to assert that a 2000-option panel renders
// only a handful of row nodes), stub offsetHeight on HTMLElement.prototype to a
// realistic pixel value so the real virtualizer computes a real, bounded range
// — the same technique used in TanStack Virtual's own jsdom tests.
function makeSubjectGroups(spec: Record<string, number>): SubjectGroup[] {
  return Object.entries(spec).map(([state, count]) => ({
    state,
    options: Array.from({ length: count }, (_, i) => ({
      value: `${state}:Subject ${i}`,
      label: `Subject ${i}`,
      count: count - i,
    })),
  }))
}

let restoreOffsetHeight: (() => void) | undefined
beforeAll(() => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
  restoreOffsetHeight = () => {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', descriptor)
  }
})
afterAll(() => { restoreOffsetHeight?.() })

describe('FilterPanel primitives', () => {
  it('always-present dropdown has no top row — just options, nothing pre-checked', () => {
    render(<FilterDropdown placeholder="Status" options={[{ value: 'a' }, { value: 'b' }]} selected={[]} onChange={() => {}} multi />)
    fireEvent.click(screen.getByText('Status'))
    expect(screen.queryByText('Any')).toBeNull() // no top row for always-present dims
    expect(screen.getByText('a')).toBeTruthy()
    expect(screen.getAllByRole('checkbox').every(cb => !(cb as HTMLInputElement).checked)).toBe(true)
  })

  it('anyIsFilter dropdown selects the has-value sentinel when "Any" is clicked', () => {
    const onChange = vi.fn()
    render(<FilterDropdown placeholder="Position" options={[{ value: 'Support' }]} selected={[]} onChange={onChange} multi anyIsFilter counts={{ [FILTER_ANY]: 5, Support: 3 }} />)
    fireEvent.click(screen.getByText('Position'))
    fireEvent.click(screen.getByText('Any'))
    expect(onChange).toHaveBeenCalledWith([FILTER_ANY])
  })

  it('"Any" can be un-checked once active (toggles back to no filter)', () => {
    const onChange = vi.fn()
    render(<FilterDropdown placeholder="Position" options={[{ value: 'Support' }]} selected={[FILTER_ANY]} onChange={onChange} multi anyIsFilter counts={{ [FILTER_ANY]: 5 }} />)
    fireEvent.click(screen.getByRole('button')) // trigger reads "Position: Any" when active
    fireEvent.click(screen.getByText('Any'))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('ActiveChip calls onRemove', () => {
    const onRemove = vi.fn()
    render(<ActiveChip label="RI" color="gray" onRemove={onRemove} />)
    fireEvent.click(screen.getByText('×'))
    expect(onRemove).toHaveBeenCalledOnce()
  })
})

// R4 follow-up: the first fix for "arrows scroll the bills table instead of
// moving between options" was wrongly applied to Picker.tsx. The Bills-page
// filter dropdowns (Status, Year, Position, Priority, Tag, custom fields) are
// actually FilterDropdown in this file, which had no focus-on-open, no arrow
// navigation, and no Escape handling at all — opening by click left focus on
// the trigger button, so ArrowUp/ArrowDown fell through to the page and
// scrolled the table.
describe('FilterDropdown — focus management on open (R4 follow-up)', () => {
  it('focuses the first option when the menu opens with no selection', () => {
    render(
      <FilterDropdown
        placeholder="Status"
        options={[{ value: 'a' }, { value: 'b' }]}
        selected={[]}
        onChange={() => {}}
        multi
      />,
    )
    fireEvent.click(screen.getByText('Status'))
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes[0]).toHaveFocus()
  })

  it('focuses the checked option when the menu opens with a selection', () => {
    render(
      <FilterDropdown
        placeholder="Status"
        options={[{ value: 'a' }, { value: 'b' }]}
        selected={['b']}
        onChange={() => {}}
        multi
      />,
    )
    fireEvent.click(screen.getByRole('button')) // trigger reads "Status (1)" with a selection
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes[1]).toHaveFocus()
  })

  it('focuses the checked "Any" row when it is active (anyIsFilter dropdowns)', () => {
    render(
      <FilterDropdown
        placeholder="Position"
        options={[{ value: 'Support' }]}
        selected={[FILTER_ANY]}
        onChange={() => {}}
        multi
        anyIsFilter
      />,
    )
    fireEvent.click(screen.getByRole('button')) // trigger reads "Position: Any" when active
    const checkboxes = screen.getAllByRole('checkbox') // Any, Support
    expect(checkboxes[0]).toHaveFocus()
  })
})

describe('FilterDropdown — keyboard navigation (R4 follow-up)', () => {
  it('lets arrow keys navigate immediately after a mouse-driven open, with no prior focus into the menu', async () => {
    const user = userEvent.setup()
    render(
      <FilterDropdown
        placeholder="Status"
        options={[{ value: 'a' }, { value: 'b' }, { value: 'c' }]}
        selected={[]}
        onChange={() => {}}
        multi
      />,
    )
    fireEvent.click(screen.getByText('Status')) // mouse-driven open — no manual focus into the menu
    const checkboxes = screen.getAllByRole('checkbox')
    await user.keyboard('{ArrowDown}')
    expect(checkboxes[1]).toHaveFocus()
  })

  it('ArrowDown/ArrowUp move focus between option inputs, wrapping at the ends', async () => {
    const user = userEvent.setup()
    render(
      <FilterDropdown
        placeholder="Status"
        options={[{ value: 'a' }, { value: 'b' }, { value: 'c' }]}
        selected={[]}
        onChange={() => {}}
        multi
      />,
    )
    fireEvent.click(screen.getByText('Status'))
    const checkboxes = screen.getAllByRole('checkbox')
    checkboxes[0].focus()
    await user.keyboard('{ArrowDown}')
    expect(checkboxes[1]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(checkboxes[2]).toHaveFocus()
    await user.keyboard('{ArrowDown}') // wraps past the last option to the first
    expect(checkboxes[0]).toHaveFocus()
    await user.keyboard('{ArrowUp}') // wraps past the first option to the last
    expect(checkboxes[2]).toHaveFocus()
  })

  it('Home/End jump focus to the first/last option', async () => {
    const user = userEvent.setup()
    render(
      <FilterDropdown
        placeholder="Status"
        options={[{ value: 'a' }, { value: 'b' }, { value: 'c' }]}
        selected={[]}
        onChange={() => {}}
        multi
      />,
    )
    fireEvent.click(screen.getByText('Status'))
    const checkboxes = screen.getAllByRole('checkbox')
    checkboxes[0].focus()
    await user.keyboard('{End}')
    expect(checkboxes[2]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(checkboxes[0]).toHaveFocus()
  })

  it('Escape closes the menu and restores focus to the trigger button', async () => {
    const user = userEvent.setup()
    render(
      <FilterDropdown
        placeholder="Status"
        options={[{ value: 'a' }, { value: 'b' }]}
        selected={[]}
        onChange={() => {}}
        multi
      />,
    )
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('selection via change events still works after keyboard focus moves between options', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <FilterDropdown
        placeholder="Status"
        options={[{ value: 'a' }, { value: 'b' }]}
        selected={[]}
        onChange={onChange}
        multi
      />,
    )
    fireEvent.click(screen.getByText('Status'))
    const checkboxes = screen.getAllByRole('checkbox')
    await user.keyboard('{ArrowDown}')
    expect(checkboxes[1]).toHaveFocus()
    fireEvent.click(checkboxes[1])
    expect(onChange).toHaveBeenCalledWith(['b'])
  })

  it('outside-mousedown close still works unchanged', () => {
    render(
      <div>
        <FilterDropdown
          placeholder="Status"
          options={[{ value: 'a' }]}
          selected={[]}
          onChange={() => {}}
          multi
        />
        <div data-testid="outside">outside</div>
      </div>,
    )
    fireEvent.click(screen.getByText('Status'))
    expect(screen.getByRole('checkbox')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})

describe('SubjectFilterDropdown', () => {
  it('hides the subject section entirely when no state publishes subjects', () => {
    renderPanel({ subjectGroups: [] })
    expect(screen.queryByText(/subjects/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders a flat list with no state heading when only one state is present', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText('UT')).not.toBeInTheDocument()
    expect(screen.getByText('Counties')).toBeInTheDocument()
  })

  it('groups options under state headings when more than one state is present', () => {
    renderPanel({
      subjectGroups: [
        { state: 'NJ', options: [{ value: 'NJ:Education', label: 'Education', count: 4 }] },
        { state: 'UT', options: [{ value: 'UT:Counties', label: 'Counties', count: 2 }] },
      ],
    })
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('NJ')).toBeInTheDocument()
    expect(screen.getByText('UT')).toBeInTheDocument()
  })

  // The notice lives outside the dropdown on purpose: it describes the whole
  // result set, and inside the dropdown it was squeezed to the button's width.
  it('warns that a subject filter excludes states with no subject data', () => {
    render(<SubjectExclusionNotice selectedSubjects={['UT:Counties']} statesWithoutSubjects={['CA', 'IL']} />)
    expect(screen.getByText(/CA, IL/)).toBeInTheDocument()
  })

  it('omits the warning when nothing is selected', () => {
    render(<SubjectExclusionNotice selectedSubjects={[]} statesWithoutSubjects={['CA', 'IL']} />)
    expect(screen.queryByText(/CA, IL/)).not.toBeInTheDocument()
  })

  it('omits the warning when every visible state publishes subjects', () => {
    render(<SubjectExclusionNotice selectedSubjects={['UT:Counties']} statesWithoutSubjects={[]} />)
    expect(screen.queryByText(/do not publish subjects/)).not.toBeInTheDocument()
  })

  it('renders the notice outside the dropdown, so it is not clipped to the button', () => {
    const { container } = render(
      <SubjectExclusionNotice selectedSubjects={['UT:Counties']} statesWithoutSubjects={['CA']} />,
    )
    expect(container.querySelector('button')).toBeNull()
  })

  it('toggles a subject on click', () => {
    const onSubjectChange = vi.fn()
    renderPanel({ onSubjectChange })
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Counties'))
    expect(onSubjectChange).toHaveBeenCalledWith(['UT:Counties'])
  })
})

// Staging has ~7,000 distinct subject terms today, heading toward ~13,400.
// Opening the panel must stay instant regardless of option count, so the
// option list is virtualized and gets a persistent, always-on search field.
describe('SubjectFilterDropdown — virtualization and search', () => {
  it('renders only a small subset of row DOM nodes for a large option list', () => {
    const groups = makeSubjectGroups({ CA: 1000, TX: 1000 }) // 2000 options total
    renderPanel({ subjectGroups: groups })
    fireEvent.click(screen.getByRole('button'))
    const checkboxes = screen.getAllByRole('checkbox')
    // A 320px-tall panel with ~30px rows fits a few dozen rows at most, even
    // with virtualizer overscan — nowhere near all 2000 options.
    expect(checkboxes.length).toBeGreaterThan(0)
    expect(checkboxes.length).toBeLessThan(100)
  })

  it('narrows visible options by label, case-insensitively', () => {
    renderPanel({
      subjectGroups: [{
        state: 'UT',
        options: [
          { value: 'UT:Counties', label: 'Counties', count: 2 },
          { value: 'UT:Education', label: 'Education', count: 5 },
        ],
      }],
    })
    fireEvent.click(screen.getByRole('button'))
    fireEvent.change(screen.getByPlaceholderText(/search subjects/i), { target: { value: 'COUN' } })
    expect(screen.getByText('Counties')).toBeInTheDocument()
    expect(screen.queryByText('Education')).not.toBeInTheDocument()
  })

  it('shows an empty-state message when the search matches nothing', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button'))
    fireEvent.change(screen.getByPlaceholderText(/search subjects/i), { target: { value: 'zzz-no-match' } })
    expect(screen.queryByText('Counties')).not.toBeInTheDocument()
    expect(screen.getByText(/no subjects match/i)).toBeInTheDocument()
  })

  it('selecting an option still toggles it, and selection survives typing into and clearing the search field', () => {
    const groups: SubjectGroup[] = [{
      state: 'UT',
      options: [
        { value: 'UT:Counties', label: 'Counties', count: 2 },
        { value: 'UT:Education', label: 'Education', count: 5 },
      ],
    }]
    const onSubjectChange = vi.fn()
    const { rerender } = render(
      <SubjectFilterDropdown
        subjectGroups={groups}
        selectedSubjects={[]}
        onSubjectChange={onSubjectChange}
      />,
    )
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Counties'))
    expect(onSubjectChange).toHaveBeenCalledWith(['UT:Counties'])

    // Simulate the parent applying the change (this component is controlled).
    rerender(
      <SubjectFilterDropdown
        subjectGroups={groups}
        selectedSubjects={['UT:Counties']}
        onSubjectChange={onSubjectChange}
      />,
    )
    const isChecked = (label: string) =>
      (screen.getByText(label).closest('label')?.querySelector('input') as HTMLInputElement).checked

    expect(isChecked('Counties')).toBe(true)

    fireEvent.change(screen.getByPlaceholderText(/search subjects/i), { target: { value: 'edu' } })
    expect(screen.queryByText('Counties')).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText(/search subjects/i), { target: { value: '' } })
    expect(isChecked('Counties')).toBe(true)
  })

  it('shows state headings only for groups with surviving matches after search; hides them when only one group survives', () => {
    renderPanel({
      subjectGroups: [
        { state: 'NJ', options: [{ value: 'NJ:Roads', label: 'Roads', count: 3 }] },
        { state: 'UT', options: [{ value: 'UT:Counties', label: 'Counties', count: 2 }] },
      ],
    })
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('NJ')).toBeInTheDocument()
    expect(screen.getByText('UT')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText(/search subjects/i), { target: { value: 'coun' } })
    // Only UT's group has a surviving match — heading noise for a single group
    // is dropped, matching the un-searched "single state, flat list" rule.
    expect(screen.queryByText('NJ')).not.toBeInTheDocument()
    expect(screen.queryByText('UT')).not.toBeInTheDocument()
    expect(screen.getByText('Counties')).toBeInTheDocument()
  })
})
