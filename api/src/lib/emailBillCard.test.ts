import { describe, it, expect } from 'vitest'
import { renderBillCardOpen, BILL_CARD_CLOSE } from './emailBillCard'
import { buildBillCardModel } from '../../../shared/billCardModel'

const model = buildBillCardModel({
  key: 'b1', billId: 'b1', billNumber: 'H 5217', billTitle: 'Test bill',
  billSessionSlug: null, billState: 'RI', billSummary: null,
  billPriority: null, billMatchType: null, date: '', events: [],
})

describe('email bill card stands alone on gray', () => {
  it('carries border, radius.lg, shadow, and bottom margin', () => {
    const open = renderBillCardOpen({ model, billHref: 'https://x', appUrl: 'https://x' })
    expect(open).toContain('border-radius:8px')
    expect(open).toContain('rgba(0,0,0,0.04)')
    expect(open).toContain('margin-bottom:8px')
  })
  it('closes the card element', () => {
    expect(BILL_CARD_CLOSE.trim().length).toBeGreaterThan(0)
  })
})
