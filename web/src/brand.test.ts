import { describe, it, expect } from 'vitest'
import { PRODUCT_NAME, PRODUCT_NAME_WORDMARK } from '../../shared/brand'

describe('brand', () => {
  it('product name is FloorVote', () => {
    expect(PRODUCT_NAME).toBe('FloorVote')
  })

  it('wordmark parts concatenate to the product name', () => {
    expect(PRODUCT_NAME_WORDMARK.primary + PRODUCT_NAME_WORDMARK.accent).toBe(PRODUCT_NAME)
  })
})
