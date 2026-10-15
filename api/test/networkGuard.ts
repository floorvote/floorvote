// The `fetch` guard installed by test/setup.ts. Kept apart from the setup file
// so test/setup.test.ts can import it and exercise the guard itself.

// Requests the guard refused since the last check. Never cleared between tests,
// because background work (`ctx.waitUntil`) can reach `fetch` after the test
// that started it has finished; the request is then reported by whichever
// check comes next rather than lost.
const blocked: string[] = []

function describeRequest(input: RequestInfo | URL, init?: RequestInit): string {
  const url = input instanceof Request ? input.url : String(input)
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  return `${method.toUpperCase()} ${url}`
}

export const networkGuard: typeof fetch = async (input, init) => {
  const request = describeRequest(input, init)
  blocked.push(request)
  throw new Error(
    `Unexpected network request: ${request}. API tests must not reach the network. ` +
    `Stub it in the test, e.g. stubFetch() from test/helpers.ts or vi.stubGlobal('fetch', vi.fn(...)).`,
  )
}

// The distinct requests refused since the last call, and forget them.
export function takeBlockedRequests(): string[] {
  const requests = [...new Set(blocked)]
  blocked.length = 0
  return requests
}
