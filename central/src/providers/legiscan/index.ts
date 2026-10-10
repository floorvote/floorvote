import { getBill, getBillText, getDatasetList, getDatasetRaw, getMasterListBySession, getMasterListRaw, getSessionList } from './client'
import { vocabulary } from './vocabulary'
import type { Provider } from '../sdk'

/**
 * LegiScan, the default provider: one API for every state, paid for out of a
 * monthly call budget. Every call is logged under its LegiScan op name, which
 * is what the dashboard's budget panels count. Central's ids are LegiScan's.
 */
export const legiscan: Provider<'LEGISCAN_API_KEY'> = {
  id: 'legiscan',
  displayName: 'LegiScan',
  envKeys: ['LEGISCAN_API_KEY'],

  listSessions: (state, ctx) =>
    getSessionList(state, ctx.env.LEGISCAN_API_KEY, () =>
      ctx.logCall('getSessionList', { state })),

  listMeasures: ({ sessionId }, ctx) =>
    getMasterListBySession(sessionId, ctx.env.LEGISCAN_API_KEY, () =>
      ctx.logCall('getMasterListBySession', { sessionId })),

  listChangeHashes: ({ sessionId }, ctx) =>
    getMasterListRaw(sessionId, ctx.env.LEGISCAN_API_KEY, () =>
      ctx.logCall('getMasterListRaw', { sessionId })),

  fetchMeasure: ({ billId }, ctx) =>
    getBill(billId, ctx.env.LEGISCAN_API_KEY, () =>
      ctx.logCall('getBill', { billId })),

  // getBillText is keyed on doc_id, not bill_id, so a bill with four text
  // versions costs four calls. Its bytes are exactly what LegiScan catalogued,
  // which is why core can check them against text_hash.
  async fetchDocument(docId, ctx) {
    const text = await getBillText(docId, ctx.env.LEGISCAN_API_KEY, () =>
      ctx.logCall('getBillText', { docId }))
    return { bytes: base64ToBytes(text.doc).buffer as ArrayBuffer, mime: text.mime, size: text.text_size }
  },

  vocabulary,

  personUrl: ({ state, name, peopleId }) =>
    `https://legiscan.com/${state}/people/${name.replace(/ /g, '-')}/id/${peopleId}`,

  // getBill carries only roll call totals, and getRollCall costs a call per
  // roll call. The weekly bulk dataset holds every getRollCall record for a
  // session, so a session's member votes cost one download.
  listVoteDatasets: async (state, ctx) =>
    (await getDatasetList(state, ctx.env.LEGISCAN_API_KEY, () =>
      ctx.logCall('getDatasetList', { state })))
      .map(d => ({ sessionId: d.session_id, hash: d.dataset_hash, key: d.access_key })),

  fetchVoteDataset: ({ sessionId, key }, ctx) =>
    getDatasetRaw(sessionId, key, ctx.env.LEGISCAN_API_KEY, () =>
      ctx.logCall('getDatasetRaw', { sessionId })),
}

/** Decode base64 (as LegiScan returns document bytes) without Node Buffer. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
