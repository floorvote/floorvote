// Preloaded into a child process (NODE_OPTIONS=--import <this file>) so a test
// that spawns a CLI can prove the CLI never leaves the machine. `fetch` is
// wrapped: a request to anything but loopback is refused without being sent,
// and a line naming the URL is written to stderr, where the test looks for it.
// The marker is also what a test greps for, so keep it in step with
// BLOCKED_MARKER in loopback-only-fetch.testutil.ts.
const realFetch = globalThis.fetch
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!LOOPBACK.has(url.hostname)) {
    process.stderr.write(`LOOPBACK-ONLY-FETCH: refused ${url.origin}${url.pathname}\n`)
    throw new TypeError(`refused a request to a non-loopback host: ${url.hostname}`)
  }
  return realFetch(input, init)
}
