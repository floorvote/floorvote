/**
 * Returns the app's primary scroll container.
 * The root layout uses <main class="app-main" style="overflowY: auto"> as the
 * scroll provider, so window.scrollTo / window.scrollY don't work — use this.
 */
export function getScrollContainer(): HTMLElement {
  return (document.querySelector('.app-main') as HTMLElement | null) ?? document.documentElement
}
