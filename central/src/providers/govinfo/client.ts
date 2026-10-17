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

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

/** An HTTP date as an ISO time (`2026-10-17T00:19:30Z`), or null when there is none or it isn't one. */
function httpDate(value: string | null): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().replace('.000Z', 'Z')
}

/**
 * Read one zip, handing each file's text to `onFile` as it is unpacked, with
 * the time GovInfo says it built the zip. Resolves with the number of files.
 *
 * Fails closed with an error that names the zip: a download that isn't a
 * complete zip (an HTTP error, a web page, a body cut off), a file that isn't
 * UTF-8, and anything `onFile` throws for a file it can't read.
 */
export async function readBillStatusZip(
  congress: number,
  type: GovInfoType,
  onFile: (name: string, xml: string, modified: string | null) => void | Promise<void>,
  onRequest?: () => void,
): Promise<number> {
  const url = billStatusZipUrl(congress, type)
  try {
    const res = await rateLimitedFetch(url, { headers: { Accept: 'application/zip' } },
      { ratePerSec: GOVINFO_RATE_PER_SEC, bucketKey: 'govinfo', onRequest })
    const modified = httpDate(res.headers.get('Last-Modified'))
    const { entries } = await readZip(res, (name, data) => onFile(name, utf8.decode(data), modified))
    return entries
  } catch (err) {
    throw new Error(`GovInfo ${congress}/${type}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
