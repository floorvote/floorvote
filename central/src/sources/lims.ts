import { fetchLimsBill } from '../lib/lims-ingest'
import { LIMS_STATE, LIMS_STATUS_LABELS } from '../lib/lims-map'
import type { DirectSource } from './types'

/** The DC Council's Legislative Information Management System (lib/lims*.ts, cron/sync-lims.ts). */
export const limsSource: DirectSource = {
  id: 'lims',
  states: [LIMS_STATE],
  // Off unless a LIMS key is configured and LIMS_STATES names DC, so a
  // deployment without one keeps DC on LegiScan.
  enabled: env => !!env.LIMS_API_KEY &&
    (env.LIMS_STATES ?? '').split(',').some(s => s.trim().toUpperCase() === LIMS_STATE),
  buildBill: fetchLimsBill,
  statusLabels: LIMS_STATUS_LABELS,
}
