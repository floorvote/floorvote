import { describe, it, expect } from 'vitest'
import { showCustomizeControl } from './Sidebar'

describe('showCustomizeControl', () => {
  it('is true only for admins/owners', () => {
    expect(showCustomizeControl('admin')).toBe(true)
    expect(showCustomizeControl('owner')).toBe(true)
    expect(showCustomizeControl('member')).toBe(false)
    expect(showCustomizeControl(undefined)).toBe(false)
  })
})
