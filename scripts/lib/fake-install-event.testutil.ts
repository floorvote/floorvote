import http from 'node:http'
import type { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'

// A local stand-in for the install-event endpoint on floorvote.org, so
// new-instance.sh's anonymous setup report can be run for real without sending
// anything anywhere. It records every request it receives and answers on
// 127.0.0.1 only.

export interface FakeInstallEvent {
  /** Base URL, e.g. http://127.0.0.1:41234. Post to `${url}/api/install-event`. */
  url: string
  /** Every request it has received, in order. `body` is the raw text. */
  posts: { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }[]
  /** How it answers: 204 (the default), 500, or never (the connection just hangs). */
  setMode(mode: 'ok' | 'error' | 'hang'): void
  /** Forget what it has received. */
  reset(): void
  close(): Promise<void>
}

export async function startFakeInstallEvent(): Promise<FakeInstallEvent> {
  let mode: 'ok' | 'error' | 'hang' = 'ok'
  const posts: FakeInstallEvent['posts'] = []
  const sockets = new Set<Socket>()

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      posts.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body })
      if (mode === 'hang') return
      res.writeHead(mode === 'error' ? 500 : 204)
      res.end()
    })
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    posts,
    setMode: (m) => { mode = m },
    reset: () => { posts.length = 0 },
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy()
      server.close(() => r())
    }),
  }
}

/** A URL on 127.0.0.1 that nothing listens on, so a connection is refused. */
export async function refusedUrl(): Promise<string> {
  const server = http.createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((r) => server.close(() => r()))
  return `http://127.0.0.1:${port}`
}
