import { rateLimitedFetch } from '../sdk'
import { readZip } from './zip'

/**
 * Client for GovInfo's Bill Status bulk data: one zip of XML files per bill
 * type per Congress, public domain, with no key.
 * https://www.govinfo.gov/bulkdata/BILLSTATUS
 *
 * A zip holds a file for each bill of its type, `BILLSTATUS-119hr3132.xml`,
 * deflated, with a data descriptor after each. The 119th Congress's eight zips
 * are 54 MB (33 MB of them House bills), and unpack to 248 MB of XML in 19,690
 * files, so a zip is always read as a stream, one file at a time.
 */
export const GOVINFO_BASE = 'https://www.govinfo.gov'

/** Congress's bill types as GovInfo names them in its paths, in the order a full read takes them. */
export const GOVINFO_TYPES = ['hr', 's', 'hres', 'sres', 'hjres', 'sjres', 'hconres', 'sconres'] as const
export type GovInfoType = typeof GOVINFO_TYPES[number]

/** Eight downloads a pass, paced as a courtesy: GovInfo documents no limit for its bulk data. */
const GOVINFO_RATE_PER_SEC = 2

export function billStatusZipUrl(congress: number, type: GovInfoType): string {
  return `${GOVINFO_BASE}/bulkdata/BILLSTATUS/${congress}/${type}/BILLSTATUS-${congress}-${type}.zip`
}

/** One bill's Bill Status file, by its own address: `.../119/hr/BILLSTATUS-119hr3132.xml`. */
export function billStatusFileUrl(congress: number, type: GovInfoType, number: string): string {
  return `${GOVINFO_BASE}/bulkdata/BILLSTATUS/${congress}/${type}/BILLSTATUS-${congress}${type}${number}.xml`
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

/** An HTTP date as an ISO time (`2026-10-17T00:19:30Z`), or null when there is none or it isn't one. */
function httpDate(value: string | null): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().replace('.000Z', 'Z')
}

/**
 * Read one zip, handing each file's text to `onFile` as it is unpacked, with
 * the time GovInfo says it built the zip. Resolves with whether the zip
 * exists, and how many files it held.
 *
 * A 404 is a zip GovInfo hasn't published yet, such as a type with no bills at
 * the start of a Congress: `found` is false and no file is handed over. The
 * caller decides what that means, since all eight missing can't be told from
 * a changed address.
 *
 * Every other failure throws an error that names the zip: a download that
 * isn't a complete zip (an HTTP error, a web page, a body cut off), a file
 * that isn't UTF-8, and anything `onFile` throws for a file it can't read.
 */
export async function readBillStatusZip(
  congress: number,
  type: GovInfoType,
  onFile: (name: string, xml: string, modified: string | null) => void | Promise<void>,
  onRequest?: () => void,
): Promise<{ found: boolean; entries: number }> {
  const url = billStatusZipUrl(congress, type)
  try {
    const res = await rateLimitedFetch(url, { headers: { Accept: 'application/zip' } },
      { ratePerSec: GOVINFO_RATE_PER_SEC, bucketKey: 'govinfo', onRequest })
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {})
      return { found: false, entries: 0 }
    }
    const modified = httpDate(res.headers.get('Last-Modified'))
    const { entries } = await readZip(res, (name, data) => onFile(name, utf8.decode(data), modified))
    return { found: true, entries }
  } catch (err) {
    throw new Error(`GovInfo ${congress}/${type}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * One bill's own Bill Status file, as text, for the ingest of a tracked bill:
 * the full read keeps only a compact record, so the detail (history, sponsors,
 * texts, and the rest) comes from downloading the file again. One file is at
 * most a few megabytes (the largest in the 119th Congress is 2.5 MB), so it is
 * read whole.
 *
 * Every answer but a 200 throws, a 404 too: a bill the full read listed has a
 * file, so a missing one is GovInfo changing something, and the ingest is
 * retried. So does a body that isn't UTF-8 text. What the text holds is the
 * caller's to check.
 */
export async function fetchBillStatusFile(
  congress: number,
  type: GovInfoType,
  number: string,
  onRequest?: () => void,
): Promise<string> {
  const url = billStatusFileUrl(congress, type, number)
  try {
    const res = await rateLimitedFetch(url, { headers: { Accept: 'application/xml' } },
      { ratePerSec: GOVINFO_RATE_PER_SEC, bucketKey: 'govinfo', onRequest })
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`HTTP ${res.status}`)
    }
    return utf8.decode(await res.arrayBuffer())
  } catch (err) {
    throw new Error(`GovInfo ${congress}/${type}/${number}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Forget every roll call and member file read so far (for tests: a real ingest lets them expire). */
export function clearRollCallCaches(): void {}
