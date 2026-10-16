// The color mode, per browser: System (the default) follows the device; Light
// and Dark override it. public/color-mode.js applies the stored choice before
// the first paint with the same key and rule; this module keeps it applied
// after that, including when the device switches while the app is open.
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

function apply(mode: ColorMode = getColorMode()): void {
  const dark = mode === 'dark' || (mode === 'system' && !!darkQuery()?.matches)
  document.documentElement.classList.toggle('dark', dark)
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
