import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { FilterDropdown, ActiveChip, FILTER_ANY, SubjectFilterDropdown } from './FilterPanel'

function renderPanel(props: Partial<ComponentProps<typeof SubjectFilterDropdown>> = {}) {
  const defaults: ComponentProps<typeof SubjectFilterDropdown> = {
    subjectGroups: [{ state: 'UT', options: [{ value: 'UT:Counties', label: 'Counties', count: 2 }] }],
    selectedSubjects: [],
    onSubjectChange: () => {},
    statesWithoutSubjects: [],
  }
  return render(<SubjectFilterDropdown {...defaults} {...props} />)
}

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

  it('warns that a subject filter excludes states with no subject data', () => {
    renderPanel({
      selectedSubjects: ['UT:Counties'],
      statesWithoutSubjects: ['CA', 'IL'],
    })
    expect(screen.getByText(/CA, IL/)).toBeInTheDocument()
  })

  it('omits the warning when nothing is selected', () => {
    renderPanel({
      selectedSubjects: [],
      statesWithoutSubjects: ['CA', 'IL'],
    })
    expect(screen.queryByText(/CA, IL/)).not.toBeInTheDocument()
  })

  it('toggles a subject on click', () => {
    const onSubjectChange = vi.fn()
    renderPanel({ onSubjectChange })
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Counties'))
    expect(onSubjectChange).toHaveBeenCalledWith(['UT:Counties'])
  })
})
