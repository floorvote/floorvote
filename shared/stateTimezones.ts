/**
 * State abbreviation to IANA timezone. Uses the timezone of each state's CAPITAL, since
 * these anchor legislative and election events rather than arbitrary points in the state.
 *
 * Lives in shared/ because both sides need it: the API anchors outbound ICS feed events
 * (api/src/routes/calendarApi.ts) and the web importer resolves a zoneless UTC DTSTART to
 * the tenant's own jurisdiction rather than to whatever zone the importing admin happens
 * to be sitting in (web/src/lib/icsImportParse.ts).
 */
// US state (+ DC) → IANA zone. Several states span two zones, so we map each to
// its CAPITOL's zone — hearings happen at the statehouse, so the capitol zone is
// the correct one (FL/IN/KY/MI → Eastern; KS/NE/ND/SD/TN/TX → Central;
// OR → Pacific; ID → Mountain).
const STATE_TZ: Record<string, string> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Denver', IL: 'America/Chicago', IN: 'America/New_York', IA: 'America/Chicago',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/New_York', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
  NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver',
  NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
}

// Map a two-letter state code to its IANA zone, or null when unknown/empty
// (the event then falls back to floating).
export function tzidForState(state: string | null | undefined): string | null {
  if (!state) return null
  return STATE_TZ[state.trim().toUpperCase()] ?? null
}
