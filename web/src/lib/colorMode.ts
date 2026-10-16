// The color mode, per browser: System (the default) follows the device; Light
// and Dark override it. public/color-mode.js applies the stored choice before
// the first paint with the same key and rule; this module keeps it applied
// after that, including when the device switches while the app is open.
import { useSyncExternalStore } from 'react'

export type ColorMode = 'system' | 'light' | 'dark'

const KEY = 'fv:color-mode'

function darkQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
}

export function getColorMode(): ColorMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch { /* storage blocked */ }
  return 'system'
}

const listeners = new Set<() => void>()

function apply(mode: ColorMode = getColorMode()): void {
  const dark = mode === 'dark' || (mode === 'system' && !!darkQuery()?.matches)
  document.documentElement.classList.toggle('dark', dark)
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

const isDarkNow = () => document.documentElement.classList.contains('dark')

/**
 * Whether the app is dark right now, for anything CSS variables can't carry (a
 * different image file, say). It reads the same `dark` class the rest of the
 * theming does, so it follows an explicit Light or Dark choice, System, and a
 * live device switch alike.
 */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, isDarkNow, () => false)
}

export function setColorMode(mode: ColorMode): void {
  try {
    if (mode === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, mode)
  } catch { /* storage blocked: still applies for this page */ }
  apply(mode)
}

/** Re-applies System mode when the device switches between light and dark. */
export function watchSystemColorMode(): void {
  darkQuery()?.addEventListener?.('change', () => apply())
}
