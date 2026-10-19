import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PartyBadge } from './PartyBadge'
import { color, fontSize, radius } from '../styles/tokens'

const chip = (code: string) => screen.getByText(code)

describe('PartyBadge colors', () => {
  it.each([
    ['D', color.bgBlueChip, color.linkBlue],
    ['R', color.bgRedPriority, color.textDanger],
    ['I', color.surfaceMuted, color.textSlate500],
    ['Green', color.surfaceMuted, color.textSlate500],
  ])('colors party %s with the sponsor chip palette', (code, bg, fg) => {
    render(<PartyBadge party={code} />)
    expect(chip(code).style.background).toBe(bg)
    expect(chip(code).style.color).toBe(fg)
  })

  it.each(['D', 'R', 'I'])('colors the mini chip for %s like the default chip', (code) => {
    const { unmount } = render(<PartyBadge party={code} />)
    const full = { bg: chip(code).style.background, fg: chip(code).style.color }
    unmount()
    render(<PartyBadge party={code} size="mini" />)
    expect({ bg: chip(code).style.background, fg: chip(code).style.color }).toEqual(full)
  })
})

describe('PartyBadge sizes', () => {
  it('keeps the default size exactly as the sponsor list had it', () => {
    render(<PartyBadge party="D" />)
    const s = chip('D').style
    expect(s.marginLeft).toBe('3px')
    expect(s.fontSize).toBe(`${fontSize.xs}px`)
    expect(s.padding).toBe('1px 4px')
    expect(s.borderRadius).toBe(radius.sm === undefined ? '' : typeof radius.sm === 'number' ? `${radius.sm}px` : String(radius.sm))
    expect(s.display).toBe('inline-block')
    expect(s.textDecoration).toBe('none')
  })

  it('makes the mini chip tighter in padding than the default, with the same type token', () => {
    const { unmount } = render(<PartyBadge party="D" />)
    const full = chip('D').style
    const fullPad = full.padding
    unmount()
    render(<PartyBadge party="D" size="mini" />)
    const mini = chip('D').style
    expect(mini.fontSize).toBe(`${fontSize.xs}px`)
    expect(mini.padding).not.toBe(fullPad)
    expect(parseFloat(mini.padding.split(' ').pop() as string)).toBeLessThan(4)
  })

  it('keeps the mini chip inline-block so a parent link underline cannot cross it', () => {
    render(<PartyBadge party="R" size="mini" />)
    expect(chip('R').style.display).toBe('inline-block')
    expect(chip('R').style.textDecoration).toBe('none')
  })
})

describe('PartyBadge accessibility', () => {
  it.each([['D', 'Democratic'], ['R', 'Republican'], ['I', 'Independent'], ['Green', 'Green']])(
    'gives party %s the accessible name "%s", in both sizes', (code, name) => {
      const { unmount } = render(<PartyBadge party={code} />)
      expect(screen.getByRole('img', { name })).toBeInTheDocument()
      unmount()
      render(<PartyBadge party={code} size="mini" />)
      expect(screen.getByRole('img', { name })).toBeInTheDocument()
    })

  it('says the party in text, so color is never the only signal', () => {
    render(<PartyBadge party="R" size="mini" />)
    expect(chip('R')).toBeVisible()
    expect(chip('R').closest('[aria-hidden="true"]')).toBeNull()
    expect(chip('R').textContent).toBe('R')
  })
})
