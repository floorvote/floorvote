import { afterEach } from 'vitest'
import '@testing-library/jest-dom'
import { configure } from '@testing-library/react'

// CI runners parallelize many jsdom test files at once; under that contention a
// single render/effect can take longer than testing-library's 1000ms default,
// intermittently timing out findBy*/waitFor assertions that are correct. Give
// async queries more headroom — real failures still surface, just a bit slower.
configure({ asyncUtilTimeout: 4000 })

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

// Node 22+'s own built-in `localStorage` global (lazy, and only functional with
// `--localstorage-file`) takes precedence over jsdom's working implementation:
// vitest's jsdom environment only overrides globals that are *not* already
// present on Node's global object, and "localStorage" already is. Left alone,
// every read/write throws "Cannot read properties of undefined", which is not
// specific to jsdom — a bare Vitest+jsdom+Node 22+ repro hits it too. Polyfill
// unconditionally (rather than probing the existing global first, which is
// itself enough to fire Node's noisy "--localstorage-file was not provided"
// warning) with a minimal in-memory Storage, so demoReadState.ts and anything
// else that reads/writes localStorage has a real, working store during tests.
{
  const store = new Map<string, string>()
  const memoryStorage: Storage = {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true, writable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: memoryStorage, configurable: true, writable: true })
  }
  // Before this polyfill, an unpatched `localStorage` call threw and was
  // swallowed by the try/catch call sites (Sidebar.tsx, demoReadState.ts), so
  // every test started clean by accident. Now that reads/writes actually land
  // in `store`, a write in one test would otherwise leak into the next test in
  // the same file — clear it globally rather than relying on each file to
  // remember its own afterEach.
  afterEach(() => { store.clear() })
}

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
