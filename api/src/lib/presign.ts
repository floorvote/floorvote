// AWS Signature Version 4 query signing ("presigned URLs"), for R2's S3 API.
//
// Hand-rolled on WebCrypto rather than pulling in aws4fetch: it is one
// function, and test/lib/presign.test.ts pins it to AWS's own worked example.
// Every header passed in is signed, so the request made with the URL must send
// each one with exactly the value given here, or R2 refuses it with
// SignatureDoesNotMatch. The body is not signed (UNSIGNED-PAYLOAD), which is
// why the server checks what arrived before it accepts an upload
// (lib/attachments.ts).

export type PresignOptions = {
  method: string
  /** The object's URL with no query string, e.g. https://<account>.r2.cloudflarestorage.com/<bucket>/<key>. */
  url: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  date: Date
  expiresSeconds: number
  headers: Record<string, string>
}

const enc = new TextEncoder()

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)))
}

async function hmac(key: ArrayBuffer | Uint8Array, s: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', k, enc.encode(s))
}

// RFC 3986 encoding, as SigV4 wants: encodeURIComponent leaves !'()* alone.
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

export async function presignUrl(o: PresignOptions): Promise<string> {
  const url = new URL(o.url)
  const amzDate = o.date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const scope = `${day}/${o.region}/s3/aws4_request`

  const headers: Record<string, string> = { host: url.host }
  for (const [k, v] of Object.entries(o.headers)) headers[k.toLowerCase()] = v.trim()
  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(';')

  const params: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${o.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(o.expiresSeconds)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ]
  const query = params
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const path = url.pathname.split('/').map(seg => rfc3986(decodeURIComponent(seg))).join('/')

  const canonicalRequest = [
    o.method,
    path,
    query,
    names.map(n => `${n}:${headers[n]}\n`).join(''),
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n')

  let key: ArrayBuffer = await hmac(enc.encode(`AWS4${o.secretAccessKey}`), day)
  for (const part of [o.region, 's3', 'aws4_request']) key = await hmac(key, part)
  const signature = hex(await hmac(key, stringToSign))

  return `${url.origin}${path}?${query}&X-Amz-Signature=${signature}`
}
