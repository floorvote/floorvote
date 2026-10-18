import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Record every subscription React makes for the hook, and whether it is still live,
// by wrapping useSyncExternalStore and calling through to the real one.
const subs: { calls: number; active: boolean }[] = []
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useSyncExternalStore: ((subscribe: (cb: () => void) => () => void, getSnapshot: () => unknown, getServer?: () => unknown) =>
      actual.useSyncExternalStore((cb) => {
        const rec = { calls: 0, active: true }
        subs.push(rec)
        const unsub = subscribe(() => { rec.calls++; cb() })
        return () => { rec.active = false; unsub() }
      }, getSnapshot, getServer)) as typeof actual.useSyncExternalStore,
  }
})

const { setColorMode, useIsDark, watchSystemColorMode } = await import('./colorMode')

let deviceDark = false
const deviceListeners = new Set<() => void>()
function stubDevice(dark: boolean) {
  deviceDark = dark
  deviceListeners.clear()
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() { return deviceDark && q.includes('dark') },
    addEventListener: (type: string, fn: () => void) => { if (type === 'change') deviceListeners.add(fn) },
    removeEventListener: (type: string, fn: () => void) => { if (type === 'change') deviceListeners.delete(fn) },
  }))
  watchSystemColorMode()
}
function switchDeviceTo(next: 'dark' | 'light') {
  act(() => {
    deviceDark = next === 'dark'
    for (const fn of deviceListeners) fn()
  })
}

// Counts renders, so "notified once per change" is observable without reaching into internals.
function mount() {
  let renders = 0
  const hook = renderHook(() => { renders++; return useIsDark() })
  return { ...hook, renders: () => renders }
}

describe('useIsDark', () => {
  beforeEach(() => {
    subs.length = 0
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.classList.remove('dark')
  })

  it('follows setColorMode between dark, light, and system', () => {
    stubDevice(true)
    setColorMode('light')
    const { result } = mount()
    expect(result.current).toBe(false)
    act(() => setColorMode('dark'))
    expect(result.current).toBe(true)
    act(() => setColorMode('light'))
    expect(result.current).toBe(false)
    act(() => setColorMode('system')) // the device is dark
    expect(result.current).toBe(true)
    deviceDark = false
    act(() => setColorMode('system'))
    expect(result.current).toBe(false)
  })

  it('reads the mode already applied when it mounts', () => {
    stubDevice(false)
    setColorMode('dark')
    expect(mount().result.current).toBe(true)
  })

  it('notifies a subscriber once per change', () => {
    stubDevice(false)
    setColorMode('light')
    const { renders } = mount()
    const before = renders()
    act(() => setColorMode('dark'))
    expect(renders() - before).toBe(1)
    act(() => setColorMode('light'))
    expect(renders() - before).toBe(2)
  })

  it('does not re-render when the mode is re-applied unchanged', () => {
    stubDevice(false)
    setColorMode('light')
    const { renders } = mount()
    const before = renders()
    act(() => setColorMode('light'))
    expect(renders() - before).toBe(0)
  })

  it('subscribes once per mounted hook', () => {
    stubDevice(false)
    mount()
    expect(subs).toHaveLength(1)
  })

  it('stops notifying after unmount', () => {
    stubDevice(false)
    setColorMode('light')
    const { unmount } = mount()
    expect(subs.filter(s => s.active)).toHaveLength(1)
    act(() => setColorMode('dark'))
    expect(subs[0].calls).toBe(1)
    unmount()
    expect(subs.filter(s => s.active)).toHaveLength(0)
    act(() => setColorMode('light'))
    // The store dropped it: no further notification reached the unmounted hook.
    expect(subs[0].calls).toBe(1)
  })

  it('keeps independent subscribers independent: one unmount leaves the other live', () => {
    stubDevice(false)
    setColorMode('light')
    const a = mount()
    const b = mount()
    a.unmount()
    act(() => setColorMode('dark'))
    expect(b.result.current).toBe(true)
  })

  it('flips on a device change under System', () => {
    stubDevice(false)
    setColorMode('system')
    const { result, renders } = mount()
    expect(result.current).toBe(false)
    const before = renders()
    switchDeviceTo('dark')
    expect(result.current).toBe(true)
    expect(renders() - before).toBe(1)
    switchDeviceTo('light')
    expect(result.current).toBe(false)
  })

  it('does not flip on a device change under an explicit Light or Dark', () => {
    stubDevice(false)
    setColorMode('light')
    const { result, renders } = mount()
    const before = renders()
    switchDeviceTo('dark')
    expect(result.current).toBe(false)
    setColorMode('dark')
    switchDeviceTo('light')
    expect(result.current).toBe(true)
    expect(renders() - before).toBe(1) // only the explicit setColorMode('dark') rendered
  })
})
