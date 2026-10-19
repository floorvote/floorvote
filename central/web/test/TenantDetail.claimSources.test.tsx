import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import TenantDetail from '../src/pages/TenantDetail'

// The claim link counts (#573) sit on the instance's detail page, beside its AI
// instructions status: how each quote the model gave resolved against the bill
// text, and two signals the reviews asked for. Invented numbers throughout.

const COUNTS = {
  analyses: { withClaimSources: 7, emptyList: 2, noList: 5 },
  items: { exact: 40, normalized: 6, fuzzy: 9, anchored: 3, ungrounded: 4, unverified: 12, total: 74 },
  cutOffRetries: 3,
  computedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
}
const ZEROS = {
  analyses: { withClaimSources: 0, emptyList: 0, noList: 0 },
  items: { exact: 0, normalized: 0, fuzzy: 0, anchored: 0, ungrounded: 0, unverified: 0, total: 0 },
  cutOffRetries: 0,
}

const tenantBody = {
  data: {
    tenant: { id: 'ri', name: 'Instance One', states: ['RI'], aiContextPersonalized: true },
    matchTypeBreakdown: { keyword: 5, manual: 2, null: 1 },
    textStatusBreakdown: { not_checked: 1, no_texts: 0, available: 7 },
    keywordEffectiveness: [],
    crossTenantBills: [],
  },
  meta: {},
}

let claimResponse: () => Response
const requested: string[] = []

beforeEach(() => {
  vi.restoreAllMocks()
  requested.length = 0
  claimResponse = () => new Response(JSON.stringify({ data: COUNTS, meta: {} }))
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    const u = String(url)
    requested.push(u)
    if (u.includes('/claim-sources')) return claimResponse()
    if (u.includes('/admin/dash/engagement/tenants/')) {
      return new Response(JSON.stringify({ data: { tenant: { id: 'ri', name: 'Instance One' }, dates: [], metrics: {}, probe: null }, meta: {} }))
    }
    if (u.includes('/admin/dash/tenants/')) {
      const id = decodeURIComponent(u.split('/admin/dash/tenants/')[1])
      return new Response(JSON.stringify({ ...tenantBody, data: { ...tenantBody.data, tenant: { ...tenantBody.data.tenant, id } } }))
    }
    return new Response('{}')
  })
})

function renderPage(path = '/tenants/ri') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/tenants/:id" element={<TenantDetail />} /></Routes>
    </MemoryRouter>,
  )
}

async function section() {
  const heading = await screen.findByRole('heading', { name: 'Summary citations' })
  const el = heading.closest('section') as HTMLElement
  // The heading shows while the counts load.
  await waitFor(() => expect(within(el).queryByText('Loading…')).toBeNull())
  return el
}

describe('the claim links section on an instance page', () => {
  it('asks for the counts of this instance only', async () => {
    renderPage()
    await section()
    expect(requested).toContain('/admin/dash/tenants/ri/claim-sources')
  })

  it('encodes the tenant id in the request', async () => {
    renderPage('/tenants/a%2Fb')
    await waitFor(() => expect(requested.some(u => u.includes('/admin/dash/tenants/a%2Fb/claim-sources'))).toBe(true))
  })

  it('shows a row for each of the six statuses with its count', async () => {
    renderPage()
    const s = within(await section())
    const row = (name: string) => s.getByRole('row', { name: new RegExp(`^${name}`) })
    expect(within(row('Exact')).getByText('40')).toBeInTheDocument()
    expect(within(row('Normalized')).getByText('6')).toBeInTheDocument()
    expect(within(row('Fuzzy')).getByText('9')).toBeInTheDocument()
    expect(within(row('Anchored')).getByText('3')).toBeInTheDocument()
    expect(within(row('Ungrounded')).getByText('4')).toBeInTheDocument()
    expect(within(row('Unverified')).getByText('12')).toBeInTheDocument()
  })

  it('shows the total, and each status as a share of it', async () => {
    renderPage()
    const s = within(await section())
    expect(within(s.getByRole('row', { name: /^Total/ })).getByText('74')).toBeInTheDocument()
    // 40 of 74
    expect(within(s.getByRole('row', { name: /^Exact/ })).getByText('54.1%')).toBeInTheDocument()
    // 12 of 74
    expect(within(s.getByRole('row', { name: /^Unverified/ })).getByText('16.2%')).toBeInTheDocument()
  })

  it('says what unverified means, since a reader would take it for a failure', async () => {
    renderPage()
    const s = within(await section())
    expect(within(s.getByRole('row', { name: /^Unverified/ })).getByText(/PDF/)).toBeInTheDocument()
  })

  it('shows how many analyses asked for claim sources and stored none, and how many had no list', async () => {
    renderPage()
    const s = within(await section())
    expect(s.getByText('Asked, none stored').parentElement).toHaveTextContent(/^Asked, none stored\s*2$/)
    expect(s.getByText('No list stored').parentElement).toHaveTextContent(/^No list stored\s*5$/)
    expect(s.getByText('With claim sources').parentElement).toHaveTextContent(/^With claim sources\s*7$/)
  })

  it('shows how many responses were cut off inside claim sources and retried without them', async () => {
    renderPage()
    const s = within(await section())
    expect(s.getByText('Cut off, retried without claim sources').parentElement).toHaveTextContent(/sources\s*3$/)
  })

  it('says how old the counts are, since they are cached', async () => {
    renderPage()
    const s = within(await section())
    expect(s.getByText(/Counted 12 minutes ago/)).toBeInTheDocument()
  })

  it('says just now for counts taken under a minute ago', async () => {
    claimResponse = () => new Response(JSON.stringify({ data: { ...COUNTS, computedAt: new Date().toISOString() }, meta: {} }))
    renderPage()
    expect(within(await section()).getByText(/Counted just now/)).toBeInTheDocument()
  })

  it('shows the counts without an age when the instance sent none', async () => {
    const { computedAt: _omit, ...noAge } = COUNTS
    claimResponse = () => new Response(JSON.stringify({ data: noAge, meta: {} }))
    renderPage()
    const s = within(await section())
    expect(s.getByRole('row', { name: /^Total/ })).toBeInTheDocument()
    expect(s.queryByText(/Counted/)).toBeNull()
  })

  it('shows an instance with none as zeros, with no share to divide by', async () => {
    claimResponse = () => new Response(JSON.stringify({ data: ZEROS, meta: {} }))
    renderPage()
    const s = within(await section())
    expect(s.getByText(/No claim sources stored yet/)).toBeInTheDocument()
    expect(s.queryByText(/NaN/)).toBeNull()
    expect(s.queryByText(/Infinity/)).toBeNull()
  })

  it('says the counts are unavailable when the instance cannot be asked, and the rest of the page still shows', async () => {
    claimResponse = () => new Response(JSON.stringify({ error: { code: 'tenant_call_failed', message: 'RPC method does not exist' } }), { status: 502 })
    renderPage()
    const s = within(await section())
    expect(s.getByText(/Summary citation counts are unavailable/)).toBeInTheDocument()
    expect(s.getByText(/RPC method does not exist/)).toBeInTheDocument()
    expect(screen.getByText(/AI instructions: personalized/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Match type' })).toBeInTheDocument()
  })

  it('says so when central has no binding for the instance', async () => {
    claimResponse = () => new Response(JSON.stringify({ error: { code: 'not_bound', message: 'Tenant is not bound to central' } }), { status: 501 })
    renderPage()
    const s = within(await section())
    expect(s.getByText(/Summary citation counts are unavailable/)).toBeInTheDocument()
    expect(s.getByText(/not bound/)).toBeInTheDocument()
  })

  it('does not fail the page on an answer of an unexpected shape', async () => {
    claimResponse = () => new Response(JSON.stringify({ data: { surprise: true }, meta: {} }))
    renderPage()
    const s = within(await section())
    expect(s.getByText(/Summary citation counts are unavailable/)).toBeInTheDocument()
    expect(screen.getByText(/AI instructions: personalized/)).toBeInTheDocument()
  })
})
