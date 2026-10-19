import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { FilterDropdown } from './FilterPanel'

// The Status control grouped under stage headings (#677). FilterDropdown keeps its multi-select behavior and gains
// heading rows: a heading is a button that selects the whole stage (it writes the stage parameter), and a status
// under it is a checkbox that writes the status parameter, with a count beside each.

const GROUPS = [
  { stage: 'enacted' as const, label: 'Enacted', count: 5, options: [{ value: 'Chaptered', label: 'Chaptered' }, { value: 'Signed', label: 'Signed' }] },
  { stage: 'in_committee' as const, label: 'In committee', count: 2, options: [{ value: 'In Committee', label: 'In Committee' }] },
  { stage: null, label: 'Other', count: null, options: [{ value: 'Not Applicable', label: 'Not Applicable' }] },
]
const COUNTS = { Chaptered: 2, Signed: 3, 'In Committee': 2, 'Not Applicable': 1 }

function renderGrouped(over: Partial<ComponentProps<typeof FilterDropdown>> = {}) {
  const onChange = vi.fn()
  const onGroupsChange = vi.fn()
  const utils = render(
    <FilterDropdown
      placeholder="Status" options={[]} selected={[]} onChange={onChange} multi counts={COUNTS}
      groups={GROUPS} selectedGroups={[]} onGroupsChange={onGroupsChange}
      {...over}
    />,
  )
  const open = () => fireEvent.click(screen.getByRole('button', { name: /^Status/ }))
  return { ...utils, onChange, onGroupsChange, open }
}

describe('FilterDropdown grouped by stage', () => {
  it('lists each stage as a heading button with its statuses beneath, in the order given', () => {
    const { open } = renderGrouped()
    open()
    const menu = screen.getByRole('group', { name: 'Status' })
    const rows = Array.from(menu.querySelectorAll('button[aria-pressed], input[type="checkbox"]')).map(el =>
      el.tagName === 'BUTTON' ? `heading:${(el.textContent ?? '').replace(/\d+$/, '')}` : `status:${el.closest('label')?.textContent?.replace(/\d+$/, '')}`)
    expect(rows).toEqual([
      'heading:Enacted', 'status:Chaptered', 'status:Signed', 'heading:In committee', 'status:In Committee', 'status:Not Applicable',
    ])
  })

  it('gives the Other heading no button, since no stage names it, and lists its statuses last', () => {
    const { open } = renderGrouped()
    open()
    expect(screen.queryByRole('button', { name: /^Other/ })).toBeNull()
    expect(screen.getByText('Other')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Not Applicable/ })).toBeInTheDocument()
  })

  it('shows a count beside each heading and each status', () => {
    const { open } = renderGrouped()
    open()
    expect(within(screen.getByRole('button', { name: /^Enacted/ })).getByText('5')).toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: /^In committee/ })).getByText('2')).toBeInTheDocument()
    expect(within(screen.getByText('Signed').closest('label')!).getByText('3')).toBeInTheDocument()
    expect(within(screen.getByText('Chaptered').closest('label')!).getByText('2')).toBeInTheDocument()
  })

  it('says on hover that a heading selects every status in its stage', () => {
    const { open } = renderGrouped()
    open()
    expect(screen.getByRole('button', { name: /^Enacted/ })).toHaveAttribute('title', 'All statuses in this stage.')
  })

  it('announces a heading as pressed when its stage is chosen', () => {
    const { open } = renderGrouped({ selectedGroups: ['enacted'] })
    open()
    expect(screen.getByRole('button', { name: /^Enacted/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /^In committee/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('chooses a stage through the groups callback, and takes it back on a second press', () => {
    const { open, onGroupsChange, onChange } = renderGrouped({ selectedGroups: ['in_committee'] })
    open()
    fireEvent.click(screen.getByRole('button', { name: /^Enacted/ }))
    expect(onGroupsChange).toHaveBeenLastCalledWith(['in_committee', 'enacted'])
    fireEvent.click(screen.getByRole('button', { name: /^In committee/ }))
    expect(onGroupsChange).toHaveBeenLastCalledWith([])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('chooses a status through the status callback, beside a chosen stage', () => {
    const { open, onGroupsChange, onChange } = renderGrouped({ selected: ['Chaptered'], selectedGroups: ['enacted'] })
    open()
    fireEvent.click(screen.getByRole('checkbox', { name: /Signed/ }))
    expect(onChange).toHaveBeenLastCalledWith(['Chaptered', 'Signed'])
    fireEvent.click(screen.getByRole('checkbox', { name: /Chaptered/ }))
    expect(onChange).toHaveBeenLastCalledWith([])
    expect(onGroupsChange).not.toHaveBeenCalled()
  })

  it('counts the stages and the statuses chosen together on the trigger', () => {
    renderGrouped({ selected: ['Signed'], selectedGroups: ['enacted', 'in_committee'] })
    expect(screen.getByRole('button', { name: 'Status (3)' })).toBeInTheDocument()
  })

  it('shows the trigger as chosen when only a stage is chosen', () => {
    renderGrouped({ selectedGroups: ['enacted'] })
    expect(screen.getByRole('button', { name: 'Status (1)' })).toBeInTheDocument()
  })

  it('reaches a heading and a status by keyboard in one order, and moves focus first to a chosen row', async () => {
    const user = userEvent.setup()
    const { open } = renderGrouped({ selected: ['Signed'] })
    open()
    // Focus lands on the chosen status, as FilterDropdown always did.
    expect(screen.getByRole('checkbox', { name: /Signed/ })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('button', { name: /^Enacted/ })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('checkbox', { name: /Chaptered/ })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('checkbox', { name: /Not Applicable/ })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('button', { name: /^Enacted/ })).toHaveFocus()
  })

  it('opens with focus on the first heading when nothing is chosen', () => {
    const { open } = renderGrouped()
    open()
    expect(screen.getByRole('button', { name: /^Enacted/ })).toHaveFocus()
  })

  it('toggles a heading from the keyboard with Space and with Enter', async () => {
    const user = userEvent.setup()
    const { open, onGroupsChange } = renderGrouped()
    open()
    await user.keyboard(' ')
    expect(onGroupsChange).toHaveBeenLastCalledWith(['enacted'])
    await user.keyboard('{Enter}')
    expect(onGroupsChange).toHaveBeenCalledTimes(2)
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    const { open } = renderGrouped()
    open()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: 'Status' })).toBeNull()
    expect(screen.getByRole('button', { name: /^Status/ })).toHaveFocus()
  })

  it('stays the plain flat list when it is given no groups', () => {
    render(<FilterDropdown placeholder="Status" options={[{ value: 'A' }, { value: 'B' }]} selected={[]} onChange={() => {}} multi counts={{ A: 1, B: 2 }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Status' }))
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /^A/ })).toBeNull()
  })

  it('lets a long status label wrap instead of widening the menu', () => {
    const long = 'A very long status label that a provider might use for a bill awaiting action by the other chamber'
    const { open } = renderGrouped({ groups: [{ stage: 'enacted', label: 'Enacted', count: 1, options: [{ value: long, label: long }] }] })
    open()
    const row = screen.getByText(long).closest('label')!
    expect(row.style.whiteSpace).not.toBe('nowrap')
    expect(row.style.minWidth).toBe('0px')
  })
})
