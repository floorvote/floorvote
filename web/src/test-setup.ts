import '@testing-library/jest-dom'

// jsdom has no IntersectionObserver (used by infinite-scroll sentinels in
// BillList/Feed). Define a no-op baseline on the global so it's always present
// — including after a test's `vi.unstubAllGlobals()`, which restores to this
// value rather than `undefined`. A late effect tick firing post-teardown then
// still finds a constructor instead of throwing "IntersectionObserver is not
// defined". Per-file stubs (e.g. BillList's FakeIntersectionObserver) still
// override this during their own tests.
class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
}
globalThis.IntersectionObserver =
  globalThis.IntersectionObserver ?? (NoopIntersectionObserver as unknown as typeof IntersectionObserver)

// jsdom has no ResizeObserver (used by Calendar to track the sticky header's
// height through web-font reflow). No-op baseline so rendering components that
// observe element size doesn't throw "ResizeObserver is not defined".
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ?? (NoopResizeObserver as unknown as typeof ResizeObserver)

// jsdom has no matchMedia (used by useIsBreakpoint for responsive layout, e.g.
// MonthGrid and the tiptap editor). Baseline to a no-op that always reports
// "no match" — i.e. the desktop layout — so components render their wide
// variant in tests. Per-file tests can override via vi.stubGlobal if needed.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
