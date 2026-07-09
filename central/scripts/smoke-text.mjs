#!/usr/bin/env node
// Post-deploy smoke check for the central bill-text path.
//
// Why this exists: the bill-text endpoints are reachable from tenants ONLY over
// the `TenantApi` service binding, which is deny-by-default
// (central/src/lib/tenantSurface.ts). A missing allowlist entry 403s a legitimate
// path SILENTLY on every tenant — that is exactly how `GET /bills/:id/text/:docId`
// (the per-version fetch the web text panel uses) broke for ~3 days. Unit tests
// now guard the allowlist, but only an end-to-end probe through a REAL tenant
// exercises tenant → binding → central → R2. Central has no staging, so we run
// this right after `deploy:legiscan` to catch breakage within seconds.
//
// The check is opt-in: it needs a reachable tenant to probe, so it runs ONLY when
// SMOKE_BASE_URL is set. Point it at a DEMO_MODE tenant (its shared auto-login
// session and ~100% R2 text coverage make it the easiest target — no SMOKE_COOKIE
// needed), or at any tenant plus a SMOKE_COOKIE. If SMOKE_BASE_URL is unset the
// check is skipped (exit 0) — a demo site is optional, so a deployment without one
// shouldn't fail its deploy here. Exits non-zero (loudly) on a real failure.

const BASE = process.env.SMOKE_BASE_URL ? process.env.SMOKE_BASE_URL.replace(/\/$/, '') : null
const ATTEMPTS = 4
const RETRY_MS = 5000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Establish an authenticated cookie. With DEMO_MODE, loading any SPA route (NOT
// the edge-cached `/` homepage, and NOT an `/api/*` path — both skip auto-login)
// runs the Worker, which creates the shared demo session and returns its cookie.
// SMOKE_COOKIE overrides this to point the probe at a non-demo tenant.
async function resolveCookie() {
  if (process.env.SMOKE_COOKIE) return process.env.SMOKE_COOKIE
  const r = await fetch(`${BASE}/bills`, { headers: { accept: 'text/html' }, redirect: 'manual' })
  const setCookie = r.headers.get('set-cookie')
  const m = setCookie && setCookie.match(/session=([^;]+)/)
  if (!m) throw new Error(`could not bootstrap a demo session from ${BASE}/bills (no session cookie set) — ` +
    `set SMOKE_COOKIE to probe a non-demo tenant`)
  return `session=${m[1]}`
}

async function findBillWithText(headers) {
  const res = await fetch(`${BASE}/api/bills?limit=100`, { headers })
  if (!res.ok) throw new Error(`bill list returned ${res.status} (auth/cookie or routing problem)`)
  const { bills } = await res.json()
  if (!Array.isArray(bills) || bills.length === 0) throw new Error('bill list was empty')

  // Fast path: a bill the AI has processed already names a known-good text docId.
  const direct = bills.find((b) => b.lastAiTextDocId)
  if (direct) return { id: direct.id, docId: direct.lastAiTextDocId, ident: direct.identifier }

  // Fallback: walk a few bill detail records to find any text version.
  for (const b of bills.slice(0, 15)) {
    const d = await fetch(`${BASE}/api/bills/${encodeURIComponent(b.id)}`, { headers })  // eslint-disable-line no-await-in-loop
    if (!d.ok) continue
    const detail = await d.json()
    const t = (detail.texts || [])[0]
    if (t) return { id: b.id, docId: t.docId, ident: b.identifier }
  }
  throw new Error('no bill with an available text version found in the first 100 results')
}

async function probeText({ id, docId, ident }, headers) {
  const url = `${BASE}/api/bills/${encodeURIComponent(id)}/text/${encodeURIComponent(docId)}`
  const res = await fetch(url, { headers })
  if (res.status !== 200) {
    throw new Error(`text fetch returned ${res.status} for bill ${ident ?? id} doc ${docId} — ${url}\n` +
      `  A 404 here is the tenant proxy seeing a non-OK from central; a 403 at the binding is the\n` +
      `  deny-by-default surface blocking the path (check central/src/lib/tenantSurface.ts ALLOW).`)
  }
  const body = await res.arrayBuffer()
  if (body.byteLength === 0) throw new Error(`text body was empty for bill ${ident ?? id} doc ${docId}`)
  return body.byteLength
}

async function main() {
  if (!BASE) {
    console.log('[smoke-text] SMOKE_BASE_URL not set — skipping bill-text smoke check (no demo/tenant target).')
    console.log('[smoke-text] To enable, set SMOKE_BASE_URL to a DEMO_MODE tenant, e.g. SMOKE_BASE_URL=https://demo.yourdomain.com')
    return
  }
  console.log(`[smoke-text] probing ${BASE} bill-text path through the tenant→central binding…`)
  let lastErr
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      const cookie = await resolveCookie()
      const headers = { cookie, accept: 'application/json' }
      const target = await findBillWithText(headers)
      const bytes = await probeText(target, headers)
      console.log(`[smoke-text] ✓ 200 OK — bill ${target.ident ?? target.id} doc ${target.docId} served ${bytes} bytes`)
      return
    } catch (err) {
      lastErr = err
      console.warn(`[smoke-text] attempt ${i}/${ATTEMPTS} failed: ${err.message}`)
      if (i < ATTEMPTS) await sleep(RETRY_MS) // tolerate brief binding propagation / cold start
    }
  }
  console.error(`\n[smoke-text] ✗ FAILED after ${ATTEMPTS} attempts — bill text is NOT being served.`)
  console.error(`[smoke-text] last error: ${lastErr?.message}`)
  process.exit(1)
}

main().catch((err) => {
  console.error(`[smoke-text] ✗ unexpected error: ${err?.stack || err}`)
  process.exit(1)
})
