import type { DemoSeedCalendarEvent, DemoSeedFeedEvent } from '../types'

// The 20 real bills the Lake Michigan Alliance tracks across Michigan, Wisconsin,
// Illinois, Indiana, and Congress. Every id, committee name, sponsor, and action
// string below is taken verbatim from the LegiScan bulk JSON recorded in
// .superpowers/sdd/lm-bill-facts.md — do not paraphrase or invent facts here.
//
// The one exception is LM_CALENDAR_EVENTS, which is disclosed fiction: the demo
// needs upcoming hearings, and LegiScan has none scheduled. Those entries name a
// plausible committee and room; everything else here is verbatim.
//
// `daysAgo` values for bill_updated events are computed from the manifest's real
// action dates relative to the reset date 2026-08-11 (see the task report for the
// full date -> daysAgo table). Where the manifest's own "status ... as of DATE"
// line coincides with the newest listed action, the status_change event is dated
// to that exact daysAgo.

/** The 20 tracked bills. `live` gates whether a hearing may be scheduled. */
export const LM_BILLS: Array<{
  externalId: string
  jurisdiction: 'MI' | 'WI' | 'IL' | 'IN' | 'US'
  billNumber: string
  live: boolean
  theme: string
}> = [
  { externalId: 'legiscan:2029026', jurisdiction: 'MI', billNumber: 'HB4427', live: true , theme: 'Beaches & Shoreline' },
  { externalId: 'legiscan:2041788', jurisdiction: 'MI', billNumber: 'HB4768', live: true , theme: 'Drinking Water' },
  { externalId: 'legiscan:2055958', jurisdiction: 'MI', billNumber: 'HB5308', live: true , theme: 'Invasive Species' },
  { externalId: 'legiscan:2129983', jurisdiction: 'MI', billNumber: 'HB5674', live: true , theme: 'Drinking Water' },
  { externalId: 'legiscan:2095619', jurisdiction: 'MI', billNumber: 'SB0771', live: true , theme: 'Septic & Wastewater' },
  { externalId: 'legiscan:2006944', jurisdiction: 'WI', billNumber: 'AB129', live: false, theme: 'Drinking Water' },
  { externalId: 'legiscan:2006749', jurisdiction: 'WI', billNumber: 'AB131', live: false, theme: 'PFAS & Contaminants' },
  { externalId: 'legiscan:1979645', jurisdiction: 'WI', billNumber: 'SB56', live: false, theme: 'Lead Service Lines' },
  { externalId: 'legiscan:2052600', jurisdiction: 'WI', billNumber: 'SB628', live: false, theme: 'Water Withdrawal' },
  { externalId: 'legiscan:1906052', jurisdiction: 'IL', billNumber: 'HB1175', live: true , theme: 'Great Lakes' },
  { externalId: 'legiscan:1952725', jurisdiction: 'IL', billNumber: 'HB2516', live: false, theme: 'PFAS & Contaminants' },
  { externalId: 'legiscan:2109237', jurisdiction: 'IL', billNumber: 'HB5268', live: true , theme: 'Water Withdrawal' },
  { externalId: 'legiscan:2111275', jurisdiction: 'IL', billNumber: 'SB4025', live: false, theme: 'Lead Service Lines' },
  { externalId: 'legiscan:2061476', jurisdiction: 'IN', billNumber: 'HB1124', live: true , theme: 'Drinking Water' },
  { externalId: 'legiscan:2056216', jurisdiction: 'IN', billNumber: 'SB0006', live: false, theme: 'Septic & Wastewater' },
  // Withdrawn 2026-01-12, six days after introduction. LegiScan's `status` field
  // still reads Introduced, so liveness had to come from the action history — the
  // one bill in the set where those two disagree.
  { externalId: 'legiscan:2065860', jurisdiction: 'IN', billNumber: 'SB0188', live: false, theme: 'Beaches & Shoreline' },
  { externalId: 'legiscan:1910159', jurisdiction: 'US', billNumber: 'HB284', live: true , theme: 'Great Lakes' },
  { externalId: 'legiscan:1933798', jurisdiction: 'US', billNumber: 'HB583', live: true , theme: 'Beaches & Shoreline' },
  { externalId: 'legiscan:2058690', jurisdiction: 'US', billNumber: 'HB6668', live: true , theme: 'PFAS & Contaminants' },
  { externalId: 'legiscan:2150744', jurisdiction: 'US', billNumber: 'HB8876', live: true , theme: 'Invasive Species' },
]

export const LM_PRIORITIES: Array<{ externalId: string; priority: 'high' | 'medium' | 'low' }> = [
  { externalId: 'legiscan:2029026', priority: 'high' },  // MI HB4427
  { externalId: 'legiscan:2041788', priority: 'low' },  // MI HB4768
  { externalId: 'legiscan:2055958', priority: 'high' },  // MI HB5308
  { externalId: 'legiscan:2129983', priority: 'medium' },  // MI HB5674
  { externalId: 'legiscan:2095619', priority: 'high' },  // MI SB0771
  { externalId: 'legiscan:2006944', priority: 'medium' },  // WI AB129
  { externalId: 'legiscan:2006749', priority: 'high' },  // WI AB131
  { externalId: 'legiscan:1979645', priority: 'high' },  // WI SB56
  { externalId: 'legiscan:2052600', priority: 'low' },  // WI SB628
  { externalId: 'legiscan:1906052', priority: 'high' },  // IL HB1175
  { externalId: 'legiscan:1952725', priority: 'medium' },  // IL HB2516
  { externalId: 'legiscan:2109237', priority: 'medium' },  // IL HB5268
  { externalId: 'legiscan:2111275', priority: 'high' },  // IL SB4025
  { externalId: 'legiscan:2061476', priority: 'high' },  // IN HB1124
  { externalId: 'legiscan:2056216', priority: 'medium' },  // IN SB0006
  { externalId: 'legiscan:2065860', priority: 'low' },  // IN SB0188
  { externalId: 'legiscan:1910159', priority: 'high' },  // US HB284
  { externalId: 'legiscan:1933798', priority: 'medium' },  // US HB583
  { externalId: 'legiscan:2058690', priority: 'medium' },  // US HB6668
  { externalId: 'legiscan:2150744', priority: 'high' },  // US HB8876
]

// Official positions — set only by one of the three org admins (demo-user =
// Marcus Weir/Policy Director, lm-user-ed = Karen Waters/Executive Director,
// lm-user-dep = Varsha Raman/Deputy Policy Director). The two dead Wisconsin bills
// (AB129, SB628) get Support too: they lost, and that's the point of tracking a
// concluded bill. SB0771 and HB8876 carry Amend/Monitor so the vocabulary isn't
// all Support.
export const LM_POSITIONS: Array<{ id: string; externalId: string; position: string; setBy: string; daysAgo: number }> = [
  { id: 'lm-pos-1',  externalId: 'legiscan:2029026', position: 'Support', setBy: 'demo-user',   daysAgo: 270 }, // MI HB4427
  { id: 'lm-pos-2',  externalId: 'legiscan:2055958', position: 'Support', setBy: 'demo-user',   daysAgo: 90 },  // MI HB5308
  { id: 'lm-pos-3',  externalId: 'legiscan:2095619', position: 'Monitor', setBy: 'demo-user',   daysAgo: 60 },  // MI SB0771
  { id: 'lm-pos-4',  externalId: 'legiscan:2006944', position: 'Support', setBy: 'lm-user-ed',  daysAgo: 200 }, // WI AB129 (died — supported anyway)
  { id: 'lm-pos-5',  externalId: 'legiscan:2006749', position: 'Support', setBy: 'lm-user-ed',  daysAgo: 200 }, // WI AB131
  { id: 'lm-pos-6',  externalId: 'legiscan:1979645', position: 'Support', setBy: 'lm-user-dep', daysAgo: 420 }, // WI SB56
  { id: 'lm-pos-7',  externalId: 'legiscan:2052600', position: 'Support', setBy: 'lm-user-dep', daysAgo: 180 }, // WI SB628 (died — supported anyway)
  { id: 'lm-pos-8',  externalId: 'legiscan:1906052', position: 'Support', setBy: 'lm-user-dep', daysAgo: 300 }, // IL HB1175
  { id: 'lm-pos-9',  externalId: 'legiscan:1952725', position: 'Support', setBy: 'lm-user-dep', daysAgo: 420 }, // IL HB2516
  { id: 'lm-pos-10', externalId: 'legiscan:2111275', position: 'Support', setBy: 'lm-user-dep', daysAgo: 60 },  // IL SB4025
  { id: 'lm-pos-11', externalId: 'legiscan:2061476', position: 'Support', setBy: 'demo-user',   daysAgo: 200 }, // IN HB1124
  { id: 'lm-pos-12', externalId: 'legiscan:2056216', position: 'Support', setBy: 'lm-user-ed',  daysAgo: 180 }, // IN SB0006
  { id: 'lm-pos-13', externalId: 'legiscan:1910159', position: 'Support', setBy: 'lm-user-ed',  daysAgo: 500 }, // US HB284
  { id: 'lm-pos-14', externalId: 'legiscan:2150744', position: 'Amend',   setBy: 'lm-user-ed',  daysAgo: 50 },  // US HB8876
]

// Spread across bills so custom-field filtering returns results in every column.
export const LM_CUSTOM_FIELD_VALUES: Array<{ externalId: string; fieldId: string; value: string; setBy: string; daysAgo: number }> = [
  // Fiscal Impact (lm-cf-1) — 10 bills
  { externalId: 'legiscan:2029026', fieldId: 'lm-cf-1', value: 'Moderate ($10K-$100K)', setBy: 'demo-user',   daysAgo: 270 }, // MI HB4427
  { externalId: 'legiscan:2055958', fieldId: 'lm-cf-1', value: 'Minimal (<$10K)',       setBy: 'demo-user',   daysAgo: 90 },  // MI HB5308
  { externalId: 'legiscan:2095619', fieldId: 'lm-cf-1', value: 'Significant (>$100K)',  setBy: 'demo-user',   daysAgo: 60 },  // MI SB0771
  { externalId: 'legiscan:2006749', fieldId: 'lm-cf-1', value: 'Significant (>$100K)',  setBy: 'lm-user-ed',  daysAgo: 200 }, // WI AB131
  { externalId: 'legiscan:1979645', fieldId: 'lm-cf-1', value: 'Significant (>$100K)',  setBy: 'lm-user-dep', daysAgo: 420 }, // WI SB56
  { externalId: 'legiscan:1906052', fieldId: 'lm-cf-1', value: 'Unknown',               setBy: 'lm-user-dep', daysAgo: 300 }, // IL HB1175
  { externalId: 'legiscan:1952725', fieldId: 'lm-cf-1', value: 'Moderate ($10K-$100K)', setBy: 'lm-user-dep', daysAgo: 420 }, // IL HB2516
  { externalId: 'legiscan:2111275', fieldId: 'lm-cf-1', value: 'Significant (>$100K)',  setBy: 'lm-user-dep', daysAgo: 60 },  // IL SB4025
  { externalId: 'legiscan:2061476', fieldId: 'lm-cf-1', value: 'Minimal (<$10K)',       setBy: 'demo-user',   daysAgo: 200 }, // IN HB1124
  { externalId: 'legiscan:2150744', fieldId: 'lm-cf-1', value: 'Moderate ($10K-$100K)', setBy: 'lm-user-ed',  daysAgo: 50 },  // US HB8876

  // Working Group (lm-cf-2) — 12 bills, mapped from each bill's theme
  { externalId: 'legiscan:2029026', fieldId: 'lm-cf-2', value: 'Habitat',        setBy: 'demo-user',   daysAgo: 270 }, // MI HB4427 — Beaches & Shoreline
  { externalId: 'legiscan:2041788', fieldId: 'lm-cf-2', value: 'Infrastructure', setBy: 'demo-user',   daysAgo: 363 }, // MI HB4768 — Drinking Water
  { externalId: 'legiscan:2055958', fieldId: 'lm-cf-2', value: 'Habitat',        setBy: 'demo-user',   daysAgo: 90 },  // MI HB5308 — Invasive Species
  { externalId: 'legiscan:2129983', fieldId: 'lm-cf-2', value: 'Infrastructure', setBy: 'demo-user',   daysAgo: 159 }, // MI HB5674 — Drinking Water
  { externalId: 'legiscan:2095619', fieldId: 'lm-cf-2', value: 'Infrastructure', setBy: 'demo-user',   daysAgo: 60 },  // MI SB0771 — Septic & Wastewater
  { externalId: 'legiscan:2006944', fieldId: 'lm-cf-2', value: 'Infrastructure', setBy: 'lm-user-ed',  daysAgo: 210 }, // WI AB129 — Drinking Water
  { externalId: 'legiscan:2006749', fieldId: 'lm-cf-2', value: 'Contaminants',   setBy: 'lm-user-ed',  daysAgo: 200 }, // WI AB131 — PFAS
  { externalId: 'legiscan:1979645', fieldId: 'lm-cf-2', value: 'Infrastructure', setBy: 'lm-user-dep', daysAgo: 420 }, // WI SB56 — Lead Service Lines
  { externalId: 'legiscan:2052600', fieldId: 'lm-cf-2', value: 'Infrastructure', setBy: 'lm-user-dep', daysAgo: 180 }, // WI SB628 — Water Withdrawal
  { externalId: 'legiscan:1906052', fieldId: 'lm-cf-2', value: 'Habitat',        setBy: 'lm-user-dep', daysAgo: 300 }, // IL HB1175 — Great Lakes
  { externalId: 'legiscan:1952725', fieldId: 'lm-cf-2', value: 'Contaminants',   setBy: 'lm-user-dep', daysAgo: 420 }, // IL HB2516 — PFAS
  { externalId: 'legiscan:2109237', fieldId: 'lm-cf-2', value: 'Infrastructure', setBy: 'lm-user-dep', daysAgo: 187 }, // IL HB5268 — Water Withdrawal

  // Policy Concerns (lm-cf-3, pinned rich text) — 4 bills, two or three plain sentences
  { externalId: 'legiscan:2029026', fieldId: 'lm-cf-3', setBy: 'demo-user', daysAgo: 270,
    value: '<p>Supports the brown alert requirement as a straightforward extension of existing county emergency-notice duties. Our only outstanding question is which county department bears the cost of maintaining the E. coli monitoring equipment the alert threshold depends on.</p>' },
  { externalId: 'legiscan:2095619', fieldId: 'lm-cf-3', setBy: 'demo-user', daysAgo: 60,
    value: '<p>The onsite wastewater assessment and evaluation requirements in the substitute are a meaningful step for septic oversight in the basin. We are watching how the evaluation cost is allocated between property owners and counties, since that detail was still being worked out in Committee of the Whole.</p>' },
  { externalId: 'legiscan:2006749', fieldId: 'lm-cf-3', setBy: 'lm-user-ed', daysAgo: 200,
    value: '<p>The PFAS program bill enacted as 2026 Wisconsin Act 201 is the strongest state-level contaminant framework we track. We are now focused on how the agency implements the testing and remediation programs it authorizes, since the statute itself leaves most of that to rulemaking.</p>' },
  { externalId: 'legiscan:2111275', fieldId: 'lm-cf-3', setBy: 'lm-user-dep', daysAgo: 60,
    value: '<p>Lead service line replacement funding enacted as Public Act 104-0572. Our concern now shifts to implementation — whether disadvantaged communities get prioritized access to the replacement funds, and how quickly utilities can staff up to do the work.</p>' },

  // Compliance Deadline (lm-cf-4) — 3 enacted bills, real effective dates from the manifest
  { externalId: 'legiscan:2006749', fieldId: 'lm-cf-4', value: '2026-04-07', setBy: 'lm-user-ed',  daysAgo: 130 }, // WI AB131 — published 4-7-2026
  { externalId: 'legiscan:1952725', fieldId: 'lm-cf-4', value: '2025-08-15', setBy: 'lm-user-dep', daysAgo: 361 }, // IL HB2516 — effective 8-15-2025
  { externalId: 'legiscan:2111275', fieldId: 'lm-cf-4', value: '2026-07-10', setBy: 'lm-user-dep', daysAgo: 32 },  // IL SB4025 — effective 7-10-2026

  // Testimony Submitted (lm-cf-5, binary) — 3 bills the team has filed on. Each
  // date is pinned to the thread that says so, since the flag and the comment are
  // the same claim rendered two ways: lm-c-6 ("Testimony is submitted", daysAgo 1),
  // lm-c-17 ("Testimony is in the record", daysAgo 3), and IL HB1175 where the ask
  // to lock in written testimony is lm-c-41 at daysAgo 5 and the drafting is still
  // in progress at lm-c-45 (daysAgo 2), so the filing has to postdate both.
  { externalId: 'legiscan:2029026', fieldId: 'lm-cf-5', value: '1', setBy: 'demo-user',   daysAgo: 1 }, // MI HB4427
  { externalId: 'legiscan:2095619', fieldId: 'lm-cf-5', value: '1', setBy: 'demo-user',   daysAgo: 3 }, // MI SB0771
  { externalId: 'legiscan:1906052', fieldId: 'lm-cf-5', value: '1', setBy: 'lm-user-dep', daysAgo: 1 }, // IL HB1175
]

// Six hearings, restricted to live bills only. No Wisconsin bill gets a hearing —
// all four have concluded (two enacted, two dead), and a future hearing on a bill
// that died in March would be incoherent.
//
// Chamber matters here. MI HB4427 and HB5308 each passed the House and were
// transmitted, so the "Referred To Committee On ..." action that follows is the
// SENATE committee of that name — hence a Senate committee in a Senate venue (the
// Binsfeld Office Building houses the Michigan Senate), which is also what their
// own threads assume ("If this passes the Senate", "our best argument in the
// Senate committee"). MI SB0771 gets no hearing at all: Committee of the Whole
// already reported it favorably and placed it on Order of Third Reading on
// 2026-06-17, so its next step is a floor vote, not a hearing. That sixth slot
// goes to MI HB5674 instead — introduced, still sitting in the House Government
// Operations Committee, and a House bill in a House committee.
export const LM_CALENDAR_EVENTS: DemoSeedCalendarEvent[] = [
  { id: 'lm-hearing-1', externalId: 'legiscan:2029026', source: 'hearing', offsetDays: 2,  time: '10:00:00', location: 'Binsfeld Office Building, Room 1100, Lansing', description: 'Senate Local Government Committee — hearing' },
  { id: 'lm-hearing-2', externalId: 'legiscan:2055958', source: 'hearing', offsetDays: 5,  time: '10:00:00', location: 'Binsfeld Office Building, Room 1200, Lansing', description: 'Senate Natural Resources and Agriculture Committee — hearing' },
  { id: 'lm-hearing-3', externalId: 'legiscan:2129983', source: 'hearing', offsetDays: 9,  time: '10:00:00', location: 'Anderson House Office Building, Room 519, Lansing', description: 'House Government Operations Committee — hearing' },
  // Energy & Environment, not Rules: Rules is where this bill was re-referred to
  // die (twice), so a hearing notice from Rules would be the least plausible thing
  // in the seed. Energy & Environment is the substantive IL House committee that
  // handles these — HB5268's own history shows Rules referring an amendment there.
  { id: 'lm-hearing-4', externalId: 'legiscan:1906052', source: 'hearing', offsetDays: 13, time: '10:00:00', location: 'Illinois State Capitol, Room 118, Springfield', description: 'House Energy & Environment Committee — hearing' },
  { id: 'lm-hearing-5', externalId: 'legiscan:2061476', source: 'hearing', offsetDays: 18, time: '10:00:00', location: 'Indiana Statehouse, Room 156-B, Indianapolis', description: 'House Public Health Committee — hearing' },
  { id: 'lm-hearing-6', externalId: 'legiscan:2150744', source: 'hearing', offsetDays: 26, time: '10:00:00', location: 'Rayburn House Office Building, Washington DC', description: 'Subcommittee on Water, Wildlife and Fisheries — hearing' },

  { id: 'lm-event-1', externalId: null, source: 'custom', offsetDays: -5, time: null, location: 'Zoom', description: 'Monthly all-staff call' },
  { id: 'lm-event-2', externalId: 'legiscan:2055958', source: 'custom', offsetDays: 3, time: '17:00:00', location: null, description: 'Testimony deadline — MI HB5308 (watercraft invasive species decals)' },
  { id: 'lm-event-3', externalId: null, source: 'custom', offsetDays: 16, time: '10:00:00', location: 'Zoom', description: 'Great Lakes coalition partner call' },
  { id: 'lm-event-4', externalId: null, source: 'custom', offsetDays: 40, time: '09:00:00', location: 'Grand Rapids, MI', description: 'Lake Michigan Alliance — annual meeting' },
]

/** One entry in a bill_updated event's `changes` array, matching ChangeRecord. */
const chg = (changeType: string, f: { oldValue?: string | null; newValue?: string; detail?: string } = {}) =>
  ({ changeType, oldValue: f.oldValue ?? null, newValue: f.newValue ?? null, detail: f.detail ?? null })

// Legislative activity, derived from each bill's real action history in
// lm-bill-facts.md. Every action string is verbatim from the manifest.
// status_change events are only used where the manifest's own "status ... as of
// DATE" line coincides with the dated action below — MI SB0771 and IL HB1175/
// HB5268, for instance, never leave the "Introduced" bucket despite committee
// activity, so no status_change is claimed for them.
export const LM_BILL_UPDATED_EVENTS: DemoSeedFeedEvent[] = [
  // MI HB4427 — Beaches & Shoreline, high, live (hearing +2)
  { id: 'lm-fe-u-mi-hb4427-1', type: 'bill_updated', externalId: 'legiscan:2029026', userId: 'system', daysAgo: 285, metadata: { changes: [
    chg('status_change', { oldValue: 'Introduced', newValue: 'Engrossed (passed one chamber)' }),
    chg('action_added', { newValue: 'Passed; Given Immediate Effect Roll Call #283 Yeas 94 Nays 10 Excused 0 Not Voting 6' }),
    chg('vote_added', { detail: 'Roll Call #283: Yeas 94, Nays 10' }),
    chg('action_added', { newValue: 'Transmitted' }),
  ] } },
  { id: 'lm-fe-u-mi-hb4427-2', type: 'bill_updated', externalId: 'legiscan:2029026', userId: 'system', daysAgo: 279, metadata: { changes: [
    chg('action_added', { newValue: 'Passed By House With Immediate Effect' }),
    chg('action_added', { newValue: 'Referred To Committee On Local Government' }),
  ] } },

  // MI HB4768 — Drinking Water, low, live
  { id: 'lm-fe-u-mi-hb4768-1', type: 'bill_updated', externalId: 'legiscan:2041788', userId: 'system', daysAgo: 363, metadata: { changes: [
    chg('status_change', { newValue: 'Introduced' }),
    chg('action_added', { newValue: 'Introduced By Representative Rep. Veronica Paiz' }),
    chg('action_added', { newValue: 'Read A First Time' }),
    chg('action_added', { newValue: 'Referred To Committee On Natural Resources And Tourism' }),
  ] } },
  { id: 'lm-fe-u-mi-hb4768-2', type: 'bill_updated', externalId: 'legiscan:2041788', userId: 'system', daysAgo: 362, metadata: { changes: [
    chg('action_added', { newValue: 'Bill Electronically Reproduced 08/13/2025' }),
  ] } },

  // MI HB5308 — Invasive Species, high, live (hearing +5)
  { id: 'lm-fe-u-mi-hb5308-1', type: 'bill_updated', externalId: 'legiscan:2055958', userId: 'system', daysAgo: 104, metadata: { changes: [
    chg('status_change', { oldValue: 'Introduced', newValue: 'Engrossed (passed one chamber)' }),
    chg('action_added', { newValue: 'Passed; Given Immediate Effect Roll Call #129 Yeas 105 Nays 1 Excused 0 Not Voting 4' }),
    chg('vote_added', { detail: 'Roll Call #129: Yeas 105, Nays 1' }),
    chg('action_added', { newValue: 'Transmitted' }),
  ] } },
  { id: 'lm-fe-u-mi-hb5308-2', type: 'bill_updated', externalId: 'legiscan:2055958', userId: 'system', daysAgo: 96, metadata: { changes: [
    chg('action_added', { newValue: 'Passed By House With Immediate Effect' }),
    chg('action_added', { newValue: 'Referred To Committee On Natural Resources And Agriculture' }),
  ] } },

  // MI HB5674 — Drinking Water, medium, live (hearing +9)
  { id: 'lm-fe-u-mi-hb5674-1', type: 'bill_updated', externalId: 'legiscan:2129983', userId: 'system', daysAgo: 159, metadata: { changes: [
    chg('status_change', { newValue: 'Introduced' }),
    chg('action_added', { newValue: 'Introduced By Representative Rep. Jennifer Wortz' }),
    chg('action_added', { newValue: 'Read A First Time' }),
    chg('action_added', { newValue: 'Referred To Committee On Government Operations' }),
  ] } },
  { id: 'lm-fe-u-mi-hb5674-2', type: 'bill_updated', externalId: 'legiscan:2129983', userId: 'system', daysAgo: 154, metadata: { changes: [
    chg('action_added', { newValue: 'Bill Electronically Reproduced 03/05/2026' }),
  ] } },

  // MI SB0771 — Septic & Wastewater, high, live, no hearing (already on Order of
  // Third Reading). Manifest's status stays "Introduced" through these Committee
  // of the Whole actions, so no status_change is claimed.
  { id: 'lm-fe-u-mi-sb0771-1', type: 'bill_updated', externalId: 'legiscan:2095619', userId: 'system', daysAgo: 69, metadata: { changes: [
    chg('action_added', { newValue: 'Referred To Committee Of The Whole With Substitute (s-2)' }),
  ] } },
  { id: 'lm-fe-u-mi-sb0771-2', type: 'bill_updated', externalId: 'legiscan:2095619', userId: 'system', daysAgo: 55, metadata: { changes: [
    chg('action_added', { newValue: 'Reported By Committee Of The Whole Favorably With Substitute (s-2)' }),
    chg('amendment_added', { newValue: 'Substitute (s-2) Concurred In' }),
    chg('action_added', { newValue: 'Placed On Order Of Third Reading With Substitute (s-2)' }),
  ] } },

  // WI AB129 — Drinking Water, medium, dead (Failed pursuant to SJR 1)
  { id: 'lm-fe-u-wi-ab129-1', type: 'bill_updated', externalId: 'legiscan:2006944', userId: 'system', daysAgo: 516, metadata: { changes: [
    chg('status_change', { newValue: 'Introduced' }),
    chg('action_added', { newValue: 'Introduced' }),
    chg('action_added', { newValue: 'Read first time and referred to Committee on Education' }),
  ] } },
  { id: 'lm-fe-u-wi-ab129-2', type: 'bill_updated', externalId: 'legiscan:2006944', userId: 'system', daysAgo: 504, metadata: { changes: [
    chg('action_added', { newValue: 'Fiscal estimate received' }),
  ] } },
  { id: 'lm-fe-u-wi-ab129', type: 'bill_updated', externalId: 'legiscan:2006944', userId: 'system', daysAgo: 141, metadata: { changes: [
    { changeType: 'status_change', oldValue: 'In Committee', newValue: 'Failed', detail: null },
    { changeType: 'action_added', oldValue: null, newValue: 'Failed to pass pursuant to Senate Joint Resolution 1', detail: null },
  ] } },

  // WI AB131 — PFAS & Contaminants, high, enacted (2026 Wisconsin Act 201)
  { id: 'lm-fe-u-wi-ab131-1', type: 'bill_updated', externalId: 'legiscan:2006749', userId: 'system', daysAgo: 131, metadata: { changes: [
    chg('action_added', { newValue: 'Presented to the Governor on 4-2-2026' }),
  ] } },
  { id: 'lm-fe-u-wi-ab131-2', type: 'bill_updated', externalId: 'legiscan:2006749', userId: 'system', daysAgo: 130, metadata: { changes: [
    chg('action_added', { newValue: 'Representative Palmeri added as a coauthor' }),
  ] } },
  { id: 'lm-fe-u-wi-ab131-3', type: 'bill_updated', externalId: 'legiscan:2006749', userId: 'system', daysAgo: 127, metadata: { changes: [
    chg('status_change', { oldValue: 'Engrossed (passed one chamber)', newValue: 'Passed/Enacted' }),
    chg('action_added', { newValue: 'Report approved by the Governor on 4-6-2026. 2026 Wisconsin Act 201' }),
    chg('action_added', { newValue: 'Published 4-7-2026' }),
  ] } },

  // WI SB56 — Lead Service Lines, high, enacted (2025 Wisconsin Act 8)
  { id: 'lm-fe-u-wi-sb56-1', type: 'bill_updated', externalId: 'legiscan:1979645', userId: 'system', daysAgo: 412, metadata: { changes: [
    chg('action_added', { newValue: 'Report correctly enrolled' }),
    chg('action_added', { newValue: 'Presented to the Governor on 6-25-2025 by directive of the Majority Leader' }),
  ] } },
  { id: 'lm-fe-u-wi-sb56-2', type: 'bill_updated', externalId: 'legiscan:1979645', userId: 'system', daysAgo: 405, metadata: { changes: [
    chg('status_change', { oldValue: 'Engrossed (passed one chamber)', newValue: 'Passed/Enacted' }),
    chg('action_added', { newValue: 'Report approved by the Governor on 7-1-2025. 2025 Wisconsin Act 8' }),
    chg('action_added', { newValue: 'Published 7-2-2025' }),
  ] } },

  // WI SB628 — Water Withdrawal, low, dead (Failed pursuant to SJR 1)
  { id: 'lm-fe-u-wi-sb628-1', type: 'bill_updated', externalId: 'legiscan:2052600', userId: 'system', daysAgo: 173, metadata: { changes: [
    chg('amendment_added', { newValue: 'Senate Amendment 1' }),
    chg('action_added', { newValue: 'Report adoption of Senate Amendment 1 recommended by Committee on Natural Resources, Veteran and Military Affairs, Ayes 4, Noes 1' }),
    chg('vote_added', { detail: 'Committee on Natural Resources, Veteran and Military Affairs: Ayes 4, Noes 1 (report passage as amended)' }),
    chg('action_added', { newValue: 'Report passage as amended recommended by Committee on Natural Resources, Veteran and Military Affairs, Ayes 4, Noes 1' }),
    chg('action_added', { newValue: 'Available for scheduling' }),
  ] } },
  { id: 'lm-fe-u-wi-sb628-2', type: 'bill_updated', externalId: 'legiscan:2052600', userId: 'system', daysAgo: 141, metadata: { changes: [
    chg('status_change', { oldValue: 'In Committee', newValue: 'Failed' }),
    chg('action_added', { newValue: 'Failed to pass pursuant to Senate Joint Resolution 1' }),
  ] } },

  // IL HB1175 — Great Lakes, high, live (hearing +13). Manifest's status stays
  // "Introduced" — this bill has spent its whole life cycling through Rules.
  { id: 'lm-fe-u-il-hb1175-1', type: 'bill_updated', externalId: 'legiscan:1906052', userId: 'system', daysAgo: 487, metadata: { changes: [
    chg('action_added', { newValue: 'Rule 19(a) / Re-referred to Rules Committee' }),
  ] } },
  { id: 'lm-fe-u-il-hb1175-2', type: 'bill_updated', externalId: 'legiscan:1906052', userId: 'system', daysAgo: 181, metadata: { changes: [
    chg('vote_added', { detail: 'Rules Committee: 005-000-000 (approved for consideration)' }),
    chg('action_added', { newValue: 'Approved for Consideration Rules Committee; 005-000-000' }),
  ] } },
  { id: 'lm-fe-u-il-hb1175-3', type: 'bill_updated', externalId: 'legiscan:1906052', userId: 'system', daysAgo: 179, metadata: { changes: [
    chg('action_added', { newValue: 'Placed on Calendar 2nd Reading - Standard Debate' }),
  ] } },
  { id: 'lm-fe-u-il-hb1175-4', type: 'bill_updated', externalId: 'legiscan:1906052', userId: 'system', daysAgo: 116, metadata: { changes: [
    chg('action_added', { newValue: 'Rule 19(a) / Re-referred to Rules Committee' }),
  ] } },

  // IL HB2516 — PFAS & Contaminants, medium, enacted (Public Act 104-0231)
  { id: 'lm-fe-u-il-hb2516-1', type: 'bill_updated', externalId: 'legiscan:1952725', userId: 'system', daysAgo: 413, metadata: { changes: [
    chg('action_added', { newValue: 'Sent to the Governor' }),
  ] } },
  { id: 'lm-fe-u-il-hb2516-2', type: 'bill_updated', externalId: 'legiscan:1952725', userId: 'system', daysAgo: 361, metadata: { changes: [
    chg('status_change', { oldValue: 'Engrossed (passed one chamber)', newValue: 'Passed/Enacted' }),
    chg('action_added', { newValue: 'Governor Approved' }),
    chg('action_added', { newValue: 'Effective Date August 15, 2025' }),
    chg('action_added', { newValue: 'Public Act . . . . . . . . . 104-0231' }),
  ] } },

  // IL HB5268 — Water Withdrawal, medium, live. Status stays "Introduced".
  { id: 'lm-fe-u-il-hb5268-1', type: 'bill_updated', externalId: 'legiscan:2109237', userId: 'system', daysAgo: 162, metadata: { changes: [
    chg('amendment_added', { newValue: 'House Committee Amendment No. 1' }),
    chg('action_added', { newValue: 'House Committee Amendment No. 1 Referred to Rules Committee' }),
  ] } },
  { id: 'lm-fe-u-il-hb5268-2', type: 'bill_updated', externalId: 'legiscan:2109237', userId: 'system', daysAgo: 146, metadata: { changes: [
    chg('action_added', { newValue: 'House Committee Amendment No. 1 Rules Refers to Energy & Environment Committee' }),
  ] } },
  { id: 'lm-fe-u-il-hb5268-3', type: 'bill_updated', externalId: 'legiscan:2109237', userId: 'system', daysAgo: 137, metadata: { changes: [
    chg('action_added', { newValue: 'Rule 19(a) / Re-referred to Rules Committee' }),
    chg('action_added', { newValue: 'House Committee Amendment No. 1 Rule 19(c) / Re-referred to Rules Committee' }),
  ] } },

  // IL SB4025 — Lead Service Lines, high, enacted (Public Act 104-0572)
  { id: 'lm-fe-u-il-sb4025-1', type: 'bill_updated', externalId: 'legiscan:2111275', userId: 'system', daysAgo: 46, metadata: { changes: [
    chg('action_added', { newValue: 'Sent to the Governor' }),
  ] } },
  { id: 'lm-fe-u-il-sb4025-2', type: 'bill_updated', externalId: 'legiscan:2111275', userId: 'system', daysAgo: 32, metadata: { changes: [
    chg('status_change', { oldValue: 'Engrossed (passed one chamber)', newValue: 'Passed/Enacted' }),
    chg('action_added', { newValue: 'Governor Approved' }),
    chg('action_added', { newValue: 'Effective Date July 10, 2026' }),
    chg('action_added', { newValue: 'Public Act . . . . . . . . . 104-0572' }),
  ] } },

  // IN HB1124 — Drinking Water, high, live (hearing +18)
  { id: 'lm-fe-u-in-hb1124-1', type: 'bill_updated', externalId: 'legiscan:2061476', userId: 'system', daysAgo: 218, metadata: { changes: [
    chg('status_change', { newValue: 'Introduced' }),
    chg('action_added', { newValue: 'Authored by Representative Jackson C' }),
    chg('action_added', { newValue: 'Coauthored by Representative Aylesworth' }),
    chg('action_added', { newValue: 'First reading: referred to Committee on Public Health' }),
  ] } },

  // IN SB0006 — Septic & Wastewater, medium, enacted (Public Law 65)
  { id: 'lm-fe-u-in-sb0006-1', type: 'bill_updated', externalId: 'legiscan:2056216', userId: 'system', daysAgo: 166, metadata: { changes: [
    chg('action_added', { newValue: 'Signed by the Speaker' }),
  ] } },
  { id: 'lm-fe-u-in-sb0006-2', type: 'bill_updated', externalId: 'legiscan:2056216', userId: 'system', daysAgo: 165, metadata: { changes: [
    chg('action_added', { newValue: 'Signed by the President of the Senate' }),
  ] } },
  { id: 'lm-fe-u-in-sb0006-3', type: 'bill_updated', externalId: 'legiscan:2056216', userId: 'system', daysAgo: 160, metadata: { changes: [
    chg('status_change', { oldValue: 'Engrossed (passed one chamber)', newValue: 'Passed/Enacted' }),
    chg('action_added', { newValue: 'Signed by the Governor' }),
    chg('action_added', { newValue: 'Public Law 65' }),
  ] } },

  // IN SB0188 — Beaches & Shoreline, low, NOT live: withdrawn 2026-01-12, six days
  // after filing (real action text, and the reason LM_BILLS marks it live: false)
  { id: 'lm-fe-u-in-sb0188-1', type: 'bill_updated', externalId: 'legiscan:2065860', userId: 'system', daysAgo: 217, metadata: { changes: [
    chg('status_change', { newValue: 'Introduced' }),
    chg('action_added', { newValue: 'Authored by Senator Bohacek' }),
    chg('action_added', { newValue: 'First reading: referred to Committee on Natural Resources' }),
  ] } },
  { id: 'lm-fe-u-in-sb0188-2', type: 'bill_updated', externalId: 'legiscan:2065860', userId: 'system', daysAgo: 211, metadata: { changes: [
    chg('status_change', { oldValue: 'Introduced', newValue: 'Withdrawn' }),
    chg('action_added', { newValue: 'Withdrawn' }),
  ] } },

  // US HB284 — Great Lakes, high, live (GLRI Act of 2025)
  { id: 'lm-fe-u-us-hb284-1', type: 'bill_updated', externalId: 'legiscan:1910159', userId: 'system', daysAgo: 579, metadata: { changes: [
    chg('status_change', { newValue: 'Introduced' }),
    chg('action_added', { newValue: 'Introduced in House' }),
    chg('action_added', { newValue: 'Referred to the House Committee on Transportation and Infrastructure.' }),
  ] } },
  { id: 'lm-fe-u-us-hb284-2', type: 'bill_updated', externalId: 'legiscan:1910159', userId: 'system', daysAgo: 578, metadata: { changes: [
    chg('action_added', { newValue: 'Referred to the Subcommittee on Water Resources and Environment.' }),
  ] } },

  // US HB583 — Beaches & Shoreline, medium, live (BEACH Act of 2025)
  { id: 'lm-fe-u-us-hb583-1', type: 'bill_updated', externalId: 'legiscan:1933798', userId: 'system', daysAgo: 567, metadata: { changes: [
    chg('status_change', { newValue: 'Introduced' }),
    chg('action_added', { newValue: 'Introduced in House' }),
    chg('action_added', { newValue: 'Referred to the House Committee on Transportation and Infrastructure.' }),
  ] } },
  { id: 'lm-fe-u-us-hb583-2', type: 'bill_updated', externalId: 'legiscan:1933798', userId: 'system', daysAgo: 566, metadata: { changes: [
    chg('action_added', { newValue: 'Referred to the Subcommittee on Water Resources and Environment.' }),
  ] } },

  // US HB6668 — PFAS & Contaminants, medium, live (Clean Water Standards for PFAS Act of 2025)
  { id: 'lm-fe-u-us-hb6668-1', type: 'bill_updated', externalId: 'legiscan:2058690', userId: 'system', daysAgo: 243, metadata: { changes: [
    chg('status_change', { newValue: 'Introduced' }),
    chg('action_added', { newValue: 'Introduced in House' }),
    chg('action_added', { newValue: 'Referred to the House Committee on Transportation and Infrastructure.' }),
  ] } },
  { id: 'lm-fe-u-us-hb6668-2', type: 'bill_updated', externalId: 'legiscan:2058690', userId: 'system', daysAgo: 190, metadata: { changes: [
    chg('action_added', { newValue: 'Referred to the Subcommittee on Water Resources and Environment.' }),
  ] } },

  // US HB8876 — Invasive Species, high, live (hearing +26; Aquatic Invasive Species Control and Prevention Act of 2026)
  { id: 'lm-fe-u-us-hb8876-1', type: 'bill_updated', externalId: 'legiscan:2150744', userId: 'system', daysAgo: 84, metadata: { changes: [
    chg('status_change', { newValue: 'Introduced' }),
    chg('action_added', { newValue: 'Introduced in House' }),
    chg('action_added', { newValue: 'Referred to the Committee on Transportation and Infrastructure, and in addition to the Committee on Natural Resources, for a period to be subsequently' }),
  ] } },
  { id: 'lm-fe-u-us-hb8876-2', type: 'bill_updated', externalId: 'legiscan:2150744', userId: 'system', daysAgo: 28, metadata: { changes: [
    chg('action_added', { newValue: 'Referred to the Subcommittee on Water, Wildlife and Fisheries.' }),
  ] } },
  { id: 'lm-fe-u-us-hb8876-3', type: 'bill_updated', externalId: 'legiscan:2150744', userId: 'system', daysAgo: 21, metadata: { changes: [
    chg('action_added', { newValue: 'Subcommittee Hearings Held' }),
  ] } },
]

/**
 * Hearing notices for three of the six scheduled hearings, so the top of the feed
 * shows movement on live Illinois, Indiana, and federal bills rather than only
 * Michigan's.
 *
 * These are `hearing_added` rather than `bill_updated`, which is what the calendar
 * reconciler emits for a real hearing (queue/processor.ts) — so nothing here
 * fabricates a LegiScan action string. Every field is read out of the matching
 * `LM_CALENDAR_EVENTS` entry, which makes the feed row and the calendar entry
 * incapable of disagreeing.
 *
 * `date` is deliberately absent. The calendar row's date is computed at reset time
 * from `offsetDays`; a date baked into this static metadata would be evaluated when
 * the module loads and would drift from it. billCardModel's hearingLine() drops
 * absent parts, so the row still reads "Hearing scheduled: 10:00 AM · <location> ·
 * <committee> — hearing".
 */
const hearingNotice = (id: string, calendarId: string, daysAgo: number): DemoSeedFeedEvent => {
  const h = LM_CALENDAR_EVENTS.find(e => e.id === calendarId)
  if (!h || h.source !== 'hearing' || h.externalId === null) {
    throw new Error(`hearingNotice: no bill-linked hearing calendar entry ${calendarId}`)
  }
  return {
    id, type: 'hearing_added', externalId: h.externalId, userId: 'system',
    metadata: { time: h.time, location: h.location, description: h.description },
    daysAgo,
  }
}

/**
 * A notice has to land before the first comment that reacts to it, or the feed
 * reads top-down as staff planning for a hearing the system announces two days
 * later. The reacting comments are lm-c-41 (IL, daysAgo 5), lm-c-58 (IN, daysAgo
 * 5), and lm-c-80 (US, daysAgo 4 — "hearing notice just went out"), so each
 * notice sits one day ahead of its own thread.
 *
 * Exported as a pair list rather than three inline calls so the test can key a
 * hearing notice on the calendar row `hearingNotice()` actually read, instead of
 * re-finding a row by bill and passing against the wrong one if a bill ever
 * carries two hearings.
 */
const LM_HEARING_NOTICES: Array<{ eventId: string; calendarId: string; daysAgo: number }> = [
  { eventId: 'lm-fe-h-il-hb1175', calendarId: 'lm-hearing-4', daysAgo: 6 },
  { eventId: 'lm-fe-h-in-hb1124', calendarId: 'lm-hearing-5', daysAgo: 6 },
  { eventId: 'lm-fe-h-us-hb8876', calendarId: 'lm-hearing-6', daysAgo: 5 },
]

export const LM_HEARING_NOTICE_SOURCES: ReadonlyArray<{ eventId: string; calendarId: string }> =
  LM_HEARING_NOTICES

export const LM_HEARING_EVENTS: DemoSeedFeedEvent[] =
  LM_HEARING_NOTICES.map(n => hearingNotice(n.eventId, n.calendarId, n.daysAgo))

// Hand-written priority_set and position_set events. Task 4 imports this name.
export const LM_ENGAGEMENT_EVENTS: DemoSeedFeedEvent[] = [
  // Priority set — one per tracked bill
  { id: 'lm-fe-p1',  type: 'priority_set', externalId: 'legiscan:2029026', userId: 'demo-user',   metadata: { priority: 'high' },   daysAgo: 280 }, // MI HB4427
  { id: 'lm-fe-p2',  type: 'priority_set', externalId: 'legiscan:2041788', userId: 'demo-user',   metadata: { priority: 'low' },    daysAgo: 363 }, // MI HB4768
  { id: 'lm-fe-p3',  type: 'priority_set', externalId: 'legiscan:2055958', userId: 'demo-user',   metadata: { priority: 'high' },   daysAgo: 100 }, // MI HB5308
  { id: 'lm-fe-p4',  type: 'priority_set', externalId: 'legiscan:2129983', userId: 'demo-user',   metadata: { priority: 'medium' }, daysAgo: 159 }, // MI HB5674
  { id: 'lm-fe-p5',  type: 'priority_set', externalId: 'legiscan:2095619', userId: 'demo-user',   metadata: { priority: 'high' },   daysAgo: 68 },  // MI SB0771
  { id: 'lm-fe-p6',  type: 'priority_set', externalId: 'legiscan:2006944', userId: 'lm-user-ed',  metadata: { priority: 'medium' }, daysAgo: 210 }, // WI AB129
  { id: 'lm-fe-p7',  type: 'priority_set', externalId: 'legiscan:2006749', userId: 'lm-user-ed',  metadata: { priority: 'high' },   daysAgo: 210 }, // WI AB131
  { id: 'lm-fe-p8',  type: 'priority_set', externalId: 'legiscan:1979645', userId: 'lm-user-dep', metadata: { priority: 'high' },   daysAgo: 430 }, // WI SB56
  { id: 'lm-fe-p9',  type: 'priority_set', externalId: 'legiscan:2052600', userId: 'lm-user-dep', metadata: { priority: 'low' },    daysAgo: 190 }, // WI SB628
  { id: 'lm-fe-p10', type: 'priority_set', externalId: 'legiscan:1906052', userId: 'lm-user-dep', metadata: { priority: 'high' },   daysAgo: 310 }, // IL HB1175
  { id: 'lm-fe-p11', type: 'priority_set', externalId: 'legiscan:1952725', userId: 'lm-user-dep', metadata: { priority: 'medium' }, daysAgo: 430 }, // IL HB2516
  { id: 'lm-fe-p12', type: 'priority_set', externalId: 'legiscan:2109237', userId: 'lm-user-dep', metadata: { priority: 'medium' }, daysAgo: 187 }, // IL HB5268
  { id: 'lm-fe-p13', type: 'priority_set', externalId: 'legiscan:2111275', userId: 'lm-user-dep', metadata: { priority: 'high' },   daysAgo: 70 },  // IL SB4025
  { id: 'lm-fe-p14', type: 'priority_set', externalId: 'legiscan:2061476', userId: 'demo-user',   metadata: { priority: 'high' },   daysAgo: 210 }, // IN HB1124
  { id: 'lm-fe-p15', type: 'priority_set', externalId: 'legiscan:2056216', userId: 'lm-user-ed',  metadata: { priority: 'medium' }, daysAgo: 190 }, // IN SB0006
  { id: 'lm-fe-p16', type: 'priority_set', externalId: 'legiscan:2065860', userId: 'demo-user',   metadata: { priority: 'low' },    daysAgo: 217 }, // IN SB0188
  { id: 'lm-fe-p17', type: 'priority_set', externalId: 'legiscan:1910159', userId: 'lm-user-ed',  metadata: { priority: 'high' },   daysAgo: 510 }, // US HB284
  { id: 'lm-fe-p18', type: 'priority_set', externalId: 'legiscan:1933798', userId: 'lm-user-ed',  metadata: { priority: 'medium' }, daysAgo: 567 }, // US HB583
  { id: 'lm-fe-p19', type: 'priority_set', externalId: 'legiscan:2058690', userId: 'lm-user-ed',  metadata: { priority: 'medium' }, daysAgo: 243 }, // US HB6668
  { id: 'lm-fe-p20', type: 'priority_set', externalId: 'legiscan:2150744', userId: 'lm-user-ed',  metadata: { priority: 'high' },   daysAgo: 60 },  // US HB8876

  // Position set — mirrors LM_POSITIONS exactly
  { id: 'lm-fe-o1',  type: 'position_set', externalId: 'legiscan:2029026', userId: 'demo-user',   metadata: { position: 'Support' }, daysAgo: 270 },
  { id: 'lm-fe-o2',  type: 'position_set', externalId: 'legiscan:2055958', userId: 'demo-user',   metadata: { position: 'Support' }, daysAgo: 90 },
  { id: 'lm-fe-o3',  type: 'position_set', externalId: 'legiscan:2095619', userId: 'demo-user',   metadata: { position: 'Monitor' }, daysAgo: 60 },
  { id: 'lm-fe-o4',  type: 'position_set', externalId: 'legiscan:2006944', userId: 'lm-user-ed',  metadata: { position: 'Support' }, daysAgo: 200 },
  { id: 'lm-fe-o5',  type: 'position_set', externalId: 'legiscan:2006749', userId: 'lm-user-ed',  metadata: { position: 'Support' }, daysAgo: 200 },
  { id: 'lm-fe-o6',  type: 'position_set', externalId: 'legiscan:1979645', userId: 'lm-user-dep', metadata: { position: 'Support' }, daysAgo: 420 },
  { id: 'lm-fe-o7',  type: 'position_set', externalId: 'legiscan:2052600', userId: 'lm-user-dep', metadata: { position: 'Support' }, daysAgo: 180 },
  { id: 'lm-fe-o8',  type: 'position_set', externalId: 'legiscan:1906052', userId: 'lm-user-dep', metadata: { position: 'Support' }, daysAgo: 300 },
  { id: 'lm-fe-o9',  type: 'position_set', externalId: 'legiscan:1952725', userId: 'lm-user-dep', metadata: { position: 'Support' }, daysAgo: 420 },
  { id: 'lm-fe-o10', type: 'position_set', externalId: 'legiscan:2111275', userId: 'lm-user-dep', metadata: { position: 'Support' }, daysAgo: 60 },
  { id: 'lm-fe-o11', type: 'position_set', externalId: 'legiscan:2061476', userId: 'demo-user',   metadata: { position: 'Support' }, daysAgo: 200 },
  { id: 'lm-fe-o12', type: 'position_set', externalId: 'legiscan:2056216', userId: 'lm-user-ed',  metadata: { position: 'Support' }, daysAgo: 180 },
  { id: 'lm-fe-o13', type: 'position_set', externalId: 'legiscan:1910159', userId: 'lm-user-ed',  metadata: { position: 'Support' }, daysAgo: 500 },
  { id: 'lm-fe-o14', type: 'position_set', externalId: 'legiscan:2150744', userId: 'lm-user-ed',  metadata: { position: 'Amend' },   daysAgo: 50 },
]

// ── Recent legislative activity (fictional) ─────────────────────────────────
//
// Everything in LM_BILL_UPDATED_EVENTS above is verbatim real action history,
// which means the feed ages: the newest real action in the manifest was ~3 weeks
// before the seed was written, and drifts further every day the demo runs. The
// practical effect is that the first screen of the feed is pure social chatter —
// comments, votes, priorities — and a visitor has to scroll back weeks before
// any legislative activity appears. That misrepresents the product, whose whole
// point is legislative activity arriving alongside the team's reaction to it.
//
// These events are INVENTED, unlike every other event in this file. They are
// written to be plausible for each bill's real chamber and status: nothing here
// advances a bill that is dead, enacts one that is pending, or claims a roll
// call. They are committee referrals, hearings, substitutions and readings —
// the procedural texture of a live session. The seed's bannerText names them as
// fictional alongside the hearing dates.
//
// If the manifest is ever refreshed with newer real actions, delete this block
// rather than growing it.
export const LM_RECENT_ACTIVITY_EVENTS: DemoSeedFeedEvent[] = [
  // MI HB5308 — Invasive Species, Engrossed, so second-chamber committee work.
  { id: 'lm-fe-r-mi-hb5308-1', type: 'bill_updated', externalId: 'legiscan:2055958', userId: 'system', daysAgo: 3, metadata: { changes: [
    chg('action_added', { newValue: 'Reported With Recommendation Without Amendment' }),
    chg('action_added', { newValue: 'Placed On Order Of Third Reading' }),
  ] } },
  { id: 'lm-fe-r-mi-hb5308-2', type: 'bill_updated', externalId: 'legiscan:2055958', userId: 'system', daysAgo: 12, metadata: { changes: [
    chg('action_added', { newValue: 'Referred To Committee On Natural Resources And Agriculture' }),
  ] } },

  // MI SB0771 — Septic & Wastewater, still Introduced; committee activity only.
  { id: 'lm-fe-r-mi-sb0771-1', type: 'bill_updated', externalId: 'legiscan:2095619', userId: 'system', daysAgo: 5, metadata: { changes: [
    chg('action_added', { newValue: 'Committee Hearing Held' }),
    chg('action_added', { newValue: 'Substitute S-1 Offered' }),
  ] } },

  // IN HB1124 — Drinking Water, Introduced; Indiana reads bills by number.
  { id: 'lm-fe-r-in-hb1124-1', type: 'bill_updated', externalId: 'legiscan:2061476', userId: 'system', daysAgo: 8, metadata: { changes: [
    chg('action_added', { newValue: 'Second reading: amended, ordered engrossed' }),
  ] } },

  // US HB8876 — Invasive Species, Introduced; federal committee referral.
  { id: 'lm-fe-r-us-hb8876-1', type: 'bill_updated', externalId: 'legiscan:2150744', userId: 'system', daysAgo: 6, metadata: { changes: [
    chg('action_added', { newValue: 'Referred to the Subcommittee on Water, Wildlife and Fisheries' }),
  ] } },

  // IL HB5268 — Water Withdrawal, Introduced; IL uses committee deadlines.
  { id: 'lm-fe-r-il-hb5268-1', type: 'bill_updated', externalId: 'legiscan:2109237', userId: 'system', daysAgo: 10, metadata: { changes: [
    chg('action_added', { newValue: 'Assigned to Energy & Environment Committee' }),
  ] } },
  { id: 'lm-fe-r-il-hb5268-2', type: 'bill_updated', externalId: 'legiscan:2109237', userId: 'system', daysAgo: 17, metadata: { changes: [
    chg('action_added', { newValue: 'Committee Deadline Extended' }),
  ] } },

  // MI HB5674 — Drinking Water, Introduced.
  { id: 'lm-fe-r-mi-hb5674-1', type: 'bill_updated', externalId: 'legiscan:2129983', userId: 'system', daysAgo: 15, metadata: { changes: [
    chg('action_added', { newValue: 'Referred To Committee On Government Operations' }),
  ] } },
]
