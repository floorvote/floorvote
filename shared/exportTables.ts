// Single source of truth for the tenant-DB tables included in the admin data
// export. Consumed by the backend (api/src/routes/exportApi.ts builds its
// tableMap from these names and a test asserts they match) and the frontend
// (web/src/lib/exportData.ts iterates this list). Keeping one list prevents the
// frontend from requesting a table the backend doesn't know — the bug that made
// the export 400 with "Unknown table name".
//
// Note: this covers only tables that live in the tenant D1. Bill *text bodies*
// (central R2) and LegiScan rich data — amendments, supplements, roll-call
// votes — are not tenant tables; the export pulls those separately via the
// /admin/export/rich endpoint.
export const EXPORT_TABLES = [
  'users',
  'bills',
  'billTexts',
  'memberVotes',
  'officialPositions',
  'comments',
  'commentReactions',
  'notes',
  'feedEvents',
  'publicReports',
  'associationConfig',
  'customFieldDefinitions',
  'billCustomFieldValues',
  'calendarEvents',
  'calendarEventBills',
] as const

export type ExportTable = (typeof EXPORT_TABLES)[number]
