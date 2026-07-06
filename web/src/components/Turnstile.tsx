import { useEffect, useRef } from 'react'

// Cloudflare Turnstile widget (explicit render). The login POST sends the
// resulting token as `turnstileToken`; the server verifies it via siteverify
// (`shared/turnstile.ts`). Explicit render (not the implicit `.cf-turnstile`
// auto-scan) because this form mounts via SPA navigation, after api.js has
// already run its one-time scan.

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string
      remove: (id: string) => void
      reset: (id?: string) => void
    }
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
let scriptPromise: Promise<void> | null = null

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = SCRIPT_SRC
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Failed to load Turnstile'))
    document.head.appendChild(s)
  })
  return scriptPromise
}

export function Turnstile({ sitekey, onToken }: { sitekey: string; onToken: (token: string | null) => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  // Keep the latest callback in a ref so the render effect depends only on
  // `sitekey` and never re-renders the widget when the parent re-renders.
  const onTokenRef = useRef(onToken)
  onTokenRef.current = onToken

  useEffect(() => {
    let cancelled = false
    loadScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile || widgetIdRef.current) return
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey,
          size: 'flexible', // fill the container so the widget matches the email/button width
          action: 'turnstile-spin-v1',
          callback: (token: string) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(null),
          'error-callback': () => onTokenRef.current(null),
        })
      })
      .catch(() => onTokenRef.current(null))
    return () => {
      cancelled = true
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current) } catch { /* widget already gone */ }
        widgetIdRef.current = null
      }
    }
  }, [sitekey])

  return <div ref={containerRef} style={{ marginBottom: 12 }} />
}
