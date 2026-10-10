import type { StatusStage } from './statusStages'

/**
 * The words central sends for LegiScan's progress codes 7 to 12. Central used
 * to send these as bare digits, which the web app decoded, so instance bills,
 * saved views, and links may still hold the digits. Migration 0076 rewrites
 * the stored digits to these words, the queue consumer does the same for a
 * central that still sends digits, and the status filter treats each digit
 * as an alias of its word.
 */
export const LEGISCAN_CODE_WORDS: Readonly<Record<string, string>> = {
  '7': 'Override',
  '8': 'Chaptered',
  '9': 'Referred',
  '10': 'Report Pass',
  '11': 'Report DNP',
  '12': 'Draft',
}

/**
 * Stage and rank for the status strings instance bills held before central
 * sent them: LegiScan's labels, the bare LegiScan codes and the words that
 * replace them, and LIMS's status names (a fork ran DC on LIMS). Migration
 * 0076 backfilled tenant bills from this table, and the queue consumer falls
 * back to it when a central from before provider vocabularies sends no rank.
 *
 * Where a LIMS name is also a LegiScan label ("Failed", "Vetoed"), LegiScan's
 * entry wins, so a LIMS bill can start one rank off within the right stage
 * until its next ingest brings LIMS's own.
 *
 * Tests keep this in step with api/migrations/0076_bill_status_stage.sql and
 * with the LegiScan and LIMS vocabularies in central.
 */
export const LEGACY_STATUS_ORDER: Readonly<Record<string, { stage: StatusStage; rank: number }>> = {
  // LegiScan
  'Draft': { stage: 'introduced', rank: 101 },
  '12': { stage: 'introduced', rank: 101 },
  'Pre-filed': { stage: 'introduced', rank: 102 },
  '0': { stage: 'introduced', rank: 102 },
  'Introduced': { stage: 'introduced', rank: 103 },
  '1': { stage: 'introduced', rank: 103 },
  'Referred': { stage: 'in_committee', rank: 201 },
  '9': { stage: 'in_committee', rank: 201 },
  'Report DNP': { stage: 'in_committee', rank: 202 },
  '11': { stage: 'in_committee', rank: 202 },
  'Report Pass': { stage: 'in_committee', rank: 203 },
  '10': { stage: 'in_committee', rank: 203 },
  'Engrossed': { stage: 'passed_one_chamber', rank: 301 },
  '2': { stage: 'passed_one_chamber', rank: 301 },
  'Enrolled': { stage: 'passed', rank: 401 },
  '3': { stage: 'passed', rank: 401 },
  'Failed': { stage: 'failed', rank: 501 },
  '6': { stage: 'failed', rank: 501 },
  'Vetoed': { stage: 'vetoed', rank: 601 },
  '5': { stage: 'vetoed', rank: 601 },
  'Passed': { stage: 'enacted', rank: 701 },
  '4': { stage: 'enacted', rank: 701 },
  'Override': { stage: 'enacted', rank: 702 },
  '7': { stage: 'enacted', rank: 702 },
  'Chaptered': { stage: 'enacted', rank: 703 },
  '8': { stage: 'enacted', rank: 703 },
  // LIMS
  'New': { stage: 'introduced', rank: 101 },
  'Under Council Review': { stage: 'in_committee', rank: 201 },
  'Under Mayoral Review': { stage: 'passed', rank: 401 },
  'Tabled': { stage: 'failed', rank: 501 },
  'Postponed Indefinitely': { stage: 'failed', rank: 502 },
  'Withdrawn': { stage: 'failed', rank: 503 },
  'Disapproved': { stage: 'failed', rank: 505 },
  'Deemed Disapproved': { stage: 'failed', rank: 506 },
  'Expired': { stage: 'failed', rank: 507 },
  'Approved': { stage: 'enacted', rank: 701 },
  'Deemed Approved': { stage: 'enacted', rank: 702 },
  'Enacted': { stage: 'enacted', rank: 703 },
  'Under Congressional Review': { stage: 'enacted', rank: 704 },
  'Official Law': { stage: 'enacted', rank: 705 },
}
