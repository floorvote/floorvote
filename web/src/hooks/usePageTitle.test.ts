import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePageTitle } from './usePageTitle'
import { PRODUCT_NAME } from '../../../shared/brand'

describe('usePageTitle', () => {
  const originalTitle = document.title

  beforeEach(() => {
    document.title = 'Original Title'
  })

  afterEach(() => {
    document.title = originalTitle
  })

  it('sets document.title to "<title> | <product name>"', () => {
    renderHook(() => usePageTitle('Dashboard'))
    expect(document.title).toBe(`Dashboard | ${PRODUCT_NAME}`)
  })

  it('restores previous title on unmount', () => {
    document.title = 'Before'
    const { unmount } = renderHook(() => usePageTitle('Page'))
    expect(document.title).toBe(`Page | ${PRODUCT_NAME}`)
    unmount()
    expect(document.title).toBe('Before')
  })

  it('does not change title when called with null', () => {
    document.title = 'Unchanged'
    renderHook(() => usePageTitle(null))
    expect(document.title).toBe('Unchanged')
  })

  it('updates title when the argument changes', () => {
    const { rerender } = renderHook(({ title }: { title: string }) => usePageTitle(title), {
      initialProps: { title: 'First' },
    })
    expect(document.title).toBe(`First | ${PRODUCT_NAME}`)
    rerender({ title: 'Second' })
    expect(document.title).toBe(`Second | ${PRODUCT_NAME}`)
  })
})
