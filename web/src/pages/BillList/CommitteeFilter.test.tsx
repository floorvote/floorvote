import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { CommitteeFilterDropdown } from './CommitteeFilter'
import { committeeGroups, type CommitteeGroup } from '../../lib/committeeGroups'

// The Committee menu (#471): each committee with its count, under its state, in the order `committeeGroups` gives,
// and a switch between the committee a bill is in now and any committee it was referred to.

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
