import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getColorMode, setColorMode, watchSystemColorMode } from './colorMode'

function deviceIsDark(dark: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: dark && q.includes('dark'), addEventListener: () => {} }))
}

describe('colorMode', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('defaults to System and follows the device', () => {
    deviceIsDark(true)
    expect(getColorMode()).toBe('system')
    setColorMode('system')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    deviceIsDark(false)
    setColorMode('system')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('stores Light and Dark per browser and overrides the device', () => {
    deviceIsDark(true)
    setColorMode('light')
    expect(getColorMode()).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    deviceIsDark(false)
    setColorMode('dark')
    expect(localStorage.getItem('fv:color-mode')).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    setColorMode('system')
    expect(localStorage.getItem('fv:color-mode')).toBeNull()
  })
})

// A device whose light/dark setting can change while the app is open.
function switchableDevice(initiallyDark: boolean) {
  let dark = initiallyDark
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() { return dark && q.includes('dark') },
    addEventListener: (type: string, fn: () => void) => { if (type === 'change') listeners.add(fn) },
    removeEventListener: (type: string, fn: () => void) => { if (type === 'change') listeners.delete(fn) },
  }))
  return {
    switchTo(next: 'dark' | 'light') {
      dark = next === 'dark'
      for (const fn of listeners) fn()
    },
  }
}

describe('colorMode follows a live device switch', () => {
  const isDark = () => document.documentElement.classList.contains('dark')
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('switches to dark and back under System when the device changes', () => {
    const device = switchableDevice(false)
    watchSystemColorMode()
    expect(isDark()).toBe(false)
    device.switchTo('dark')
    expect(isDark()).toBe(true)
    device.switchTo('light')
    expect(isDark()).toBe(false)
  })

  it('ignores a device switch while Light is chosen', () => {
    const device = switchableDevice(false)
    watchSystemColorMode()
    setColorMode('light')
    device.switchTo('dark')
    expect(isDark()).toBe(false)
  })

  it('ignores a device switch while Dark is chosen', () => {
    const device = switchableDevice(true)
    watchSystemColorMode()
    setColorMode('dark')
    device.switchTo('light')
    expect(isDark()).toBe(true)
  })

  it('follows the device again after going back to System', () => {
    const device = switchableDevice(false)
    watchSystemColorMode()
    setColorMode('dark')
    setColorMode('system')
    expect(isDark()).toBe(false)
    device.switchTo('dark')
    expect(isDark()).toBe(true)
  })

  it('does nothing without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(() => watchSystemColorMode()).not.toThrow()
  })
})

// public/color-mode.js applies the mode before the app loads; colorMode.ts takes
// over after. They must agree on the key and the rule, or the page flips on load.
describe('the pre-paint script agrees with colorMode', () => {
  const script = readFileSync(resolve(__dirname, '../../public/color-mode.js'), 'utf8')
  const runScript = () => new Function(script)()
  afterEach(() => vi.unstubAllGlobals())

  const STORED = [null, 'light', 'dark', 'bogus'] as const
  for (const stored of STORED) {
    for (const deviceDark of [false, true]) {
      it(`stored ${stored ?? 'nothing'}, device ${deviceDark ? 'dark' : 'light'}`, () => {
        localStorage.clear()
        if (stored) localStorage.setItem('fv:color-mode', stored)
        deviceIsDark(deviceDark)
        document.documentElement.classList.remove('dark')
        runScript()
        const fromScript = document.documentElement.classList.contains('dark')
        document.documentElement.classList.remove('dark')
        setColorMode(getColorMode())
        expect(fromScript).toBe(document.documentElement.classList.contains('dark'))
      })
    }
  }
})
