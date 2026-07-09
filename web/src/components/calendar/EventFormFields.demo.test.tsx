import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

const { demo } = vi.hoisted(() => ({ demo: { demoMode: false, demoLocked: false } }))
vi.mock('../../context/DemoContext', () => ({ useDemo: () => demo }))
vi.mock('../BillPicker', () => ({ BillPicker: () => React.createElement('div', { 'data-testid': 'bill-picker' }) }))

import { EventFormFields, type EventFormValues } from './EventFormFields'

const VALID: EventFormValues = {
  description: 'Board meeting', date: '2099-01-01', time: null, location: null, billIds: [], details: null, url: null,
}

beforeEach(() => { demo.demoLocked = false })

describe('EventFormFields demo gating', () => {
  it('enables Save for a valid form when not demo', () => {
    render(<EventFormFields initial={VALID} billOptions={[]} multiState={false} onSave={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: /^save$/i })).not.toBeDisabled()
  })

  it('disables Save in demo even for a valid form', () => {
    demo.demoLocked = true
    render(<EventFormFields initial={VALID} billOptions={[]} multiState={false} onSave={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })
})
