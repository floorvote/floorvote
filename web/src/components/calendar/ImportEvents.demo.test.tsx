import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

const { demo } = vi.hoisted(() => ({ demo: { demoMode: false, demoLocked: false } }))
vi.mock('../../context/DemoContext', () => ({ useDemo: () => demo }))
vi.mock('../../lib/api', () => ({ apiFetch: vi.fn() }))

import { ImportEvents } from './ImportEvents'

beforeEach(() => { demo.demoLocked = false })

describe('ImportEvents demo gating', () => {
  it('enables download template and file input when not demo', () => {
    render(<ImportEvents onClose={() => {}} onImported={() => {}} />)
    expect(screen.getByRole('button', { name: /download template/i })).not.toBeDisabled()
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).not.toBeDisabled()
  })

  it('disables download template and file input in demo', () => {
    demo.demoLocked = true
    render(<ImportEvents onClose={() => {}} onImported={() => {}} />)
    expect(screen.getByRole('button', { name: /download template/i })).toBeDisabled()
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).toBeDisabled()
  })
})
