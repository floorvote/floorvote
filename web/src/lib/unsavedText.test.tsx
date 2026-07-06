import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { createUnsavedRegistry, UnsavedTextContext, useUnsavedRegistration } from './unsavedText'

describe('createUnsavedRegistry', () => {
  it('reports no unsaved when empty', () => {
    const reg = createUnsavedRegistry()
    expect(reg.hasUnsaved()).toBe(false)
  })

  it('hasUnsaved reflects dirty entries; unregister removes them', () => {
    const reg = createUnsavedRegistry()
    let dirty = false
    const unregister = reg.register({ isDirty: () => dirty, reset: () => {} })
    expect(reg.hasUnsaved()).toBe(false)
    dirty = true
    expect(reg.hasUnsaved()).toBe(true)
    unregister()
    expect(reg.hasUnsaved()).toBe(false)
  })

  it('resetAll resets only dirty entries', () => {
    const reg = createUnsavedRegistry()
    const cleanReset = vi.fn()
    const dirtyReset = vi.fn()
    reg.register({ isDirty: () => false, reset: cleanReset })
    reg.register({ isDirty: () => true, reset: dirtyReset })
    reg.resetAll()
    expect(cleanReset).not.toHaveBeenCalled()
    expect(dirtyReset).toHaveBeenCalledOnce()
  })
})

describe('useUnsavedRegistration', () => {
  it('registers with the context provider and unregisters on unmount', () => {
    const reg = createUnsavedRegistry()
    let dirty = false
    function Field() {
      useUnsavedRegistration({ isDirty: () => dirty, reset: () => {} })
      return null
    }
    const { rerender, unmount } = render(
      <UnsavedTextContext.Provider value={reg}>
        <Field />
      </UnsavedTextContext.Provider>,
    )
    expect(reg.hasUnsaved()).toBe(false)
    dirty = true
    rerender(
      <UnsavedTextContext.Provider value={reg}>
        <Field />
      </UnsavedTextContext.Provider>,
    )
    expect(reg.hasUnsaved()).toBe(true)
    unmount()
    expect(reg.hasUnsaved()).toBe(false)
  })

  it('is a no-op when no provider is present', () => {
    function Field() {
      useUnsavedRegistration({ isDirty: () => true, reset: () => {} })
      return null
    }
    expect(() => render(<Field />)).not.toThrow()
  })
})
