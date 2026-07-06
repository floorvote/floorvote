import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FilterDropdown, ActiveChip, FILTER_ANY } from './FilterPanel'

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
