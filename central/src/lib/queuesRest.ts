// ── Cloudflare Queues REST client ─────────────────────────────────────────
// Lets central create a tenant's delivery queue and HTTP-publish bills to it by
// queue_id, instead of requiring a hand-added TENANT_QUEUE_<ID> producer binding
// + a central redeploy per onboard. Gated on CF_QUEUES_TOKEN (a Queues: Edit API
// token) + CF_ACCOUNT_ID; every call no-ops / throws cleanly when unset so the
// static-binding path stays the default.
//
// API contract verified empirically against the live REST API (2026-06-17):
//   create : POST /accounts/{acct}/queues            {queue_name}        -> result.queue_id
//   list   : GET  /accounts/{acct}/queues?per_page=100                   -> result[].{queue_id,queue_name}
//   single : POST /accounts/{acct}/queues/{id}/messages        {body}
//   batch  : POST /accounts/{acct}/queues/{id}/messages/batch  {messages:[{body},...]}  (separate endpoint)

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

/** Max messages per HTTP batch publish (mirrors the binding's sendBatch(100) cap). */
const HTTP_BATCH_MAX = 100

type QueuesEnv = { CF_QUEUES_TOKEN?: string; CF_ACCOUNT_ID?: string }

export function queuesRestEnabled(env: QueuesEnv): boolean {
  return !!env.CF_QUEUES_TOKEN && !!env.CF_ACCOUNT_ID
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

type CfList = { success?: boolean; result?: { queue_id: string; queue_name: string }[]; errors?: unknown }
type CfCreate = { success?: boolean; result?: { queue_id?: string }; errors?: unknown }
type CfWrite = { success?: boolean; errors?: unknown }

/** Find a queue's id by exact name, or null if it doesn't exist. */
export async function resolveQueueId(env: QueuesEnv, queueName: string): Promise<string | null> {
  if (!queuesRestEnabled(env)) return null
  const url = `${CF_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/queues?per_page=100`
  const res = await fetch(url, { headers: authHeaders(env.CF_QUEUES_TOKEN!) })
  if (!res.ok) throw new Error(`queues list failed: HTTP ${res.status} ${await res.text()}`)
  const body = (await res.json()) as CfList
  if (!body.success || !Array.isArray(body.result)) {
    throw new Error(`queues list returned an error: ${JSON.stringify(body.errors ?? body)}`)
  }
  return body.result.find((q) => q.queue_name === queueName)?.queue_id ?? null
}

/** Resolve a queue's id by name, creating it if it doesn't exist. Returns null when disabled. */
export async function ensureQueue(env: QueuesEnv, queueName: string): Promise<string | null> {
  if (!queuesRestEnabled(env)) return null
  const existing = await resolveQueueId(env, queueName)
  if (existing) return existing
  const url = `${CF_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/queues`
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(env.CF_QUEUES_TOKEN!),
    body: JSON.stringify({ queue_name: queueName }),
  })
  if (!res.ok) throw new Error(`queue create failed: HTTP ${res.status} ${await res.text()}`)
  const body = (await res.json()) as CfCreate
  if (!body.success || !body.result?.queue_id) {
    throw new Error(`queue create returned an error: ${JSON.stringify(body.errors ?? body)}`)
  }
  return body.result.queue_id
}

/** HTTP-publish a single message body to a queue by id. */
export async function publishMessage(env: QueuesEnv, queueId: string, body: unknown): Promise<void> {
  if (!queuesRestEnabled(env)) throw new Error('CF_QUEUES_TOKEN / CF_ACCOUNT_ID unset')
  const url = `${CF_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/queues/${queueId}/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(env.CF_QUEUES_TOKEN!),
    body: JSON.stringify({ body }),
  })
  if (!res.ok) throw new Error(`queue publish failed: HTTP ${res.status} ${await res.text()}`)
  const j = (await res.json()) as CfWrite
  if (!j.success) throw new Error(`queue publish returned an error: ${JSON.stringify(j.errors)}`)
}

/** HTTP-publish many message bodies to a queue, chunked to the per-batch cap. No-op for an empty list. */
export async function publishBatch(env: QueuesEnv, queueId: string, bodies: unknown[]): Promise<void> {
  if (bodies.length === 0) return
  if (!queuesRestEnabled(env)) throw new Error('CF_QUEUES_TOKEN / CF_ACCOUNT_ID unset')
  const url = `${CF_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/queues/${queueId}/messages/batch`
  for (let i = 0; i < bodies.length; i += HTTP_BATCH_MAX) {
    const chunk = bodies.slice(i, i + HTTP_BATCH_MAX)
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(env.CF_QUEUES_TOKEN!),
      body: JSON.stringify({ messages: chunk.map((b) => ({ body: b })) }),
    })
    if (!res.ok) throw new Error(`queue batch publish failed: HTTP ${res.status} ${await res.text()}`)
    const j = (await res.json()) as CfWrite
    if (!j.success) throw new Error(`queue batch publish returned an error: ${JSON.stringify(j.errors)}`)
  }
}
