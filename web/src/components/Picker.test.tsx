import { useState } from 'react'
import { describe, it, expect } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Picker } from './Picker'

function SingleHarness({
  initial = null as string | null,
  ariaLabel,
}: {
  initial?: string | null
  ariaLabel?: string
}) {
  const [value, setValue] = useState<string | null>(initial)
  return (
    <Picker
      mode="single"
      value={value}
      options={[
        { value: 'a', label: 'Apple' },
        { value: 'b', label: 'Banana' },
      ]}
      onChange={(v) => setValue(v)}
      emptyOption={{ label: 'Not set' }}
      ariaLabel={ariaLabel}
      trigger={({ toggle }) => (
        <button onClick={toggle}>{`val:${value ?? ''}`}</button>
      )}
    />
  )
}

function MultiHarness({
  initial = [] as string[],
  indeterminate,
  ariaLabel,
}: {
  initial?: string[]
  indeterminate?: Set<string>
  ariaLabel?: string
}) {
  const [value, setValue] = useState<string[]>(initial)
  return (
    <Picker
      mode="multi"
      value={value}
      indeterminate={indeterminate}
      options={[
        { value: 'a', label: 'Apple' },
        { value: 'b', label: 'Banana' },
        { value: 'c', label: 'Cherry' },
      ]}
      onChange={(v) => setValue(v)}
      ariaLabel={ariaLabel}
      trigger={({ toggle }) => (
        <button onClick={toggle}>{`val:${value.join(',')}`}</button>
      )}
    />
  )
}

describe('Picker — single mode', () => {
  it('opens when trigger clicked and shows options', () => {
    render(<SingleHarness />)
    expect(screen.queryByText('Apple')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Apple')).toBeInTheDocument()
    expect(screen.getByText('Banana')).toBeInTheDocument()
  })

  it('selects an option and updates value', () => {
    render(<SingleHarness />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Apple'))
    expect(screen.getByRole('button').textContent).toBe('val:a')
  })

  it('shows the empty option', () => {
    render(<SingleHarness initial="a" />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Not set'))
    expect(screen.getByRole('button').textContent).toBe('val:')
  })
})

describe('Picker — option descriptions', () => {
  // `describedFirst` controls whether the row with a description would be
  // auto-focused on open by virtue of being first (index 0) when nothing is
  // selected. `initial` lets a test make the described option the SELECTED
  // one instead, so it's the one auto-focused regardless of array order.
  function DescHarness({
    describedFirst = true,
    initial = null as string | null,
  }: { describedFirst?: boolean; initial?: string | null } = {}) {
    const [value, setValue] = useState<string | null>(initial)
    const options = describedFirst
      ? [
          { value: 'a', label: 'Apple', description: 'A red fruit' },
          { value: 'b', label: 'Banana' },
        ]
      : [
          { value: 'b', label: 'Banana' },
          { value: 'a', label: 'Apple', description: 'A red fruit' },
        ]
    return (
      <Picker
        mode="single"
        value={value}
        options={options}
        onChange={(v) => setValue(v)}
        trigger={({ toggle }) => <button onClick={toggle}>open</button>}
      />
    )
  }

  it('reveals the description tooltip on row hover and hides it otherwise', () => {
    // Banana (no description) is first, so it — not Apple — gets auto-focused
    // on open; this isolates hover as the thing revealing Apple's tooltip.
    render(<DescHarness describedFirst={false} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText('A red fruit')).not.toBeInTheDocument()
    fireEvent.mouseEnter(screen.getByText('Apple'))
    expect(screen.getByText('A red fruit')).toBeInTheDocument()
    fireEvent.mouseLeave(screen.getByText('Apple'))
    expect(screen.queryByText('A red fruit')).not.toBeInTheDocument()
  })

  it('does not pop the description tooltip for the synthetic auto-focus on open, even when the SELECTED option has one — but hover and later real focus still reveal it', async () => {
    const user = userEvent.setup()
    // Apple has a description and is the selected value, so it's the option
    // R4's open-effect auto-focuses. This mirrors the real regression: Feed's
    // scope selector defaults to its first ("default") option, which has a
    // description, and CustomizeSidebar's "rich" selects behave the same way.
    render(<DescHarness initial="a" />)
    fireEvent.click(screen.getByRole('button'))
    const radios = screen.getAllByRole('radio') // Apple, Banana
    expect(radios[0]).toHaveFocus() // R4 still works: focus lands on the selected option
    expect(screen.queryByText('A red fruit')).not.toBeInTheDocument() // but no unrequested tooltip pop

    // Hover still reveals it, exactly as before.
    fireEvent.mouseEnter(screen.getByText('Apple'))
    expect(screen.getByText('A red fruit')).toBeInTheDocument()
    fireEvent.mouseLeave(screen.getByText('Apple'))
    expect(screen.queryByText('A red fruit')).not.toBeInTheDocument()

    // A subsequent *real* focus move (arrow-key nav away and back) still reveals it too.
    await user.keyboard('{ArrowDown}') // -> Banana
    expect(screen.queryByText('A red fruit')).not.toBeInTheDocument()
    await user.keyboard('{ArrowUp}') // -> back to Apple, a genuine focus move
    expect(radios[0]).toHaveFocus()
    expect(screen.getByText('A red fruit')).toBeInTheDocument()
  })
})

describe('Picker — multi mode', () => {
  it('toggles values without closing', () => {
    render(<MultiHarness />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Apple'))
    fireEvent.click(screen.getByText('Banana'))
    expect(screen.getByRole('button').textContent).toBe('val:a,b')
    expect(screen.getByText('Cherry')).toBeInTheDocument() // panel still open
  })

  it('unselects a checked option', () => {
    render(<MultiHarness initial={['a', 'b']} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Apple'))
    expect(screen.getByRole('button').textContent).toBe('val:b')
  })

  it('indeterminate option becomes checked on click (commits to "add")', () => {
    render(<MultiHarness indeterminate={new Set(['a'])} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Apple'))
    expect(screen.getByRole('button').textContent).toBe('val:a')
  })
})

describe('Picker — ARIA roles', () => {
  it('single mode exposes a named radiogroup, not a listbox', () => {
    render(<SingleHarness />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Options' })).toBeInTheDocument()
  })

  it('multi mode exposes a named group, not a listbox', () => {
    render(<MultiHarness />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Options' })).toBeInTheDocument()
  })

  it('uses a caller-supplied ariaLabel as the accessible name (single mode)', () => {
    render(<SingleHarness ariaLabel="Fruit" />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('radiogroup', { name: 'Fruit' })).toBeInTheDocument()
  })

  it('uses a caller-supplied ariaLabel as the accessible name (multi mode)', () => {
    render(<MultiHarness ariaLabel="Tags" />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('group', { name: 'Tags' })).toBeInTheDocument()
  })

  it('rows still expose native radio/checkbox controls (correct checked-state semantics)', () => {
    render(<SingleHarness initial="a" />)
    fireEvent.click(screen.getByRole('button'))
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3) // "Not set" + Apple + Banana
    expect((radios[1] as HTMLInputElement).checked).toBe(true)
  })
})

describe('Picker — focus management on open (R4)', () => {
  it('focuses the selected option when the menu opens (single mode)', () => {
    render(<SingleHarness initial="a" />)
    fireEvent.click(screen.getByRole('button'))
    const radios = screen.getAllByRole('radio') // Not set, Apple, Banana
    expect(radios[1]).toHaveFocus() // Apple is selected
  })

  it('focuses the empty-option row when it is the selected one (single mode, no value)', () => {
    render(<SingleHarness />)
    fireEvent.click(screen.getByRole('button'))
    const radios = screen.getAllByRole('radio')
    expect(radios[0]).toHaveFocus() // "Not set" is selected when value is null
  })

  it('focuses the first option when the menu opens with no selection (multi mode)', () => {
    render(<MultiHarness />)
    fireEvent.click(screen.getByRole('button'))
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes[0]).toHaveFocus()
  })

  it('lets arrow keys navigate immediately after a mouse-driven open, with no prior focus into the panel', async () => {
    // Regression test for the reported bug: opening by clicking the trigger left
    // focus on the trigger, so ArrowDown/ArrowUp never reached handleMenuKeyDown
    // and instead scrolled the surrounding page/table.
    const user = userEvent.setup()
    render(<SingleHarness />)
    fireEvent.click(screen.getByRole('button')) // mouse-driven open — no manual focus into the menu
    const radios = screen.getAllByRole('radio')
    await user.keyboard('{ArrowDown}')
    expect(radios[1]).toHaveFocus()
  })

  it('closing still restores focus to the trigger after an auto-focused open', async () => {
    const user = userEvent.setup()
    render(<SingleHarness />)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})

describe('Picker — keyboard navigation', () => {
  it('ArrowDown/ArrowUp move focus between option rows (single mode), wrapping at the ends', async () => {
    const user = userEvent.setup()
    render(<SingleHarness />)
    fireEvent.click(screen.getByRole('button'))
    const radios = screen.getAllByRole('radio') // Not set, Apple, Banana
    radios[0].focus()
    await user.keyboard('{ArrowDown}')
    expect(radios[1]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(radios[2]).toHaveFocus()
    await user.keyboard('{ArrowDown}') // wraps past the last option to the first
    expect(radios[0]).toHaveFocus()
    await user.keyboard('{ArrowUp}') // wraps past the first option to the last
    expect(radios[2]).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(radios[1]).toHaveFocus()
  })

  it('ArrowDown on the last option wraps to the first, and ArrowUp on the first wraps to the last (multi mode, #5 follow-up)', async () => {
    const user = userEvent.setup()
    render(<MultiHarness />)
    fireEvent.click(screen.getByRole('button'))
    const checkboxes = screen.getAllByRole('checkbox') // Apple, Banana, Cherry
    checkboxes[2].focus()
    await user.keyboard('{ArrowDown}')
    expect(checkboxes[0]).toHaveFocus()
    checkboxes[0].focus()
    await user.keyboard('{ArrowUp}')
    expect(checkboxes[2]).toHaveFocus()
  })

  it('ArrowDown/ArrowUp move focus between option rows (multi mode)', async () => {
    const user = userEvent.setup()
    render(<MultiHarness />)
    fireEvent.click(screen.getByRole('button'))
    const checkboxes = screen.getAllByRole('checkbox')
    checkboxes[0].focus()
    await user.keyboard('{ArrowDown}')
    expect(checkboxes[1]).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(checkboxes[0]).toHaveFocus()
  })

  it('Home/End jump focus to the first/last option', async () => {
    const user = userEvent.setup()
    render(<MultiHarness />)
    fireEvent.click(screen.getByRole('button'))
    const checkboxes = screen.getAllByRole('checkbox')
    checkboxes[0].focus()
    await user.keyboard('{End}')
    expect(checkboxes[2]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(checkboxes[0]).toHaveFocus()
  })

  it('Escape closes the menu and restores focus to the trigger', async () => {
    const user = userEvent.setup()
    render(<SingleHarness />)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    const radios = screen.getAllByRole('radio')
    radios[0].focus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('selection via click still works (single mode closes on select)', () => {
    render(<SingleHarness />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Apple'))
    expect(screen.getByRole('button').textContent).toBe('val:a')
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  it('selection via click still works (multi mode stays open)', () => {
    render(<MultiHarness />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Apple'))
    expect(screen.getByRole('button').textContent).toBe('val:a')
    expect(screen.getByRole('group')).toBeInTheDocument()
  })
})
