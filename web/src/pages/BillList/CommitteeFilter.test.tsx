import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { CommitteeFilterDropdown } from './CommitteeFilter'
import type { CommitteeGroup } from '../../lib/committeeGroups'

// The Committee menu (#471): each committee with its count, under its state, procedural committees last and tagged,
// and a switch between the committee a bill is in now and any committee it was referred to.

const GROUPS: CommitteeGroup[] = [
  { state: 'NJ', options: [
    { value: '101', label: 'Judiciary (Senate)', count: 12, procedural: false },
    { value: '102', label: 'Rules (Senate)', count: 140, procedural: true },
  ] },
  { state: 'TX', options: [{ value: '201', label: 'State Affairs (House)', count: 4, procedural: false }] },
]

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

  it('tags a procedural committee, and lists it after the others', () => {
    const { menu } = renderMenu()
    const labels = within(menu).getAllByRole('checkbox').map(c => c.closest('label')!.textContent)
    expect(labels[0]).toMatch(/^Judiciary/)
    expect(labels[1]).toMatch(/^Rules \(Senate\)Procedural/)
    expect(labels[0]).not.toMatch(/Procedural/)
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
