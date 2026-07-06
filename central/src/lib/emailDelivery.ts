export interface DeliveryStatus { status: string; isSpam: boolean; errorCause?: string; datetime?: string }

// CF's Analytics GraphQL schema types zoneTag as the lowercase custom scalar `string`
// (per the Email Service docs examples) — do NOT "correct" it to `String!`, which the
// zone schema rejects. `Time` is capitalized. Verified shape against CF email docs.
const QUERY = `query($zoneTag:string!,$start:Time!){viewer{zones(filter:{zoneTag:$zoneTag}){emailSendingAdaptive(filter:{datetime_geq:$start},limit:10000,orderBy:[datetime_DESC]){messageId status isSpam errorCause datetime}}}}`

/**
 * Look up CF Email Sending delivery status for specific message ids via the
 * zone-level emailSendingAdaptive GraphQL dataset. Returns {} (unknown) when
 * creds are absent or on any error — never throws. The dataset has no messageId
 * filter, so we fetch the window since `since` and match client-side.
 */
export async function getEmailDeliveryStatus(
  env: { CF_ANALYTICS_TOKEN?: string; CF_FLOORVOTE_ZONE_ID?: string },
  opts: { messageIds: string[]; since: string },
): Promise<Record<string, DeliveryStatus>> {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_FLOORVOTE_ZONE_ID || opts.messageIds.length === 0) return {}
  const want = new Set(opts.messageIds)
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { zoneTag: env.CF_FLOORVOTE_ZONE_ID, start: opts.since } }),
    })
    if (!res.ok) { console.error('[email-delivery]', res.status, await res.text().catch(() => '')); return {} }
    const json = await res.json() as { data?: { viewer?: { zones?: Array<{ emailSendingAdaptive?: Array<{ messageId: string; status: string; isSpam: number; errorCause?: string; datetime?: string }> }> } } }
    const events = json.data?.viewer?.zones?.[0]?.emailSendingAdaptive ?? []
    const out: Record<string, DeliveryStatus> = {}
    for (const e of events) {
      // events are datetime_DESC, so the first one seen per messageId is the latest
      if (want.has(e.messageId) && !out[e.messageId]) {
        out[e.messageId] = { status: e.status, isSpam: !!e.isSpam, errorCause: e.errorCause || undefined, datetime: e.datetime }
      }
    }
    return out
  } catch (e) { console.error('[email-delivery] error', e); return {} }
}
