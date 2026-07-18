# LegiScan API v1.91 — Reference

Revision 20250317. Pull API base URL: `https://api.legiscan.com/?key=APIKEY&op=OPERATION&PARAMS`

Keys, operations, state abbreviations and bill numbers are **case-insensitive**.  
Free tier (public service): **30,000 queries/month**.  
Successful response: `{"status":"OK", ...}`. Error: `{"status":"ERROR", "alert":{"message":"..."}}`

---

## Three API Modes

| Mode | Description |
|---|---|
| **Pull** | Client-driven HTTP requests. Our mode. 30k queries/month free. |
| **Push** | Paid. LegiScan POSTs to your endpoint every 15min–4hr when bills change. Adds `last_push` + `reasons[]` array (25 change flags) to bill payload. |
| **Bulk** | Weekly ZIP datasets via `getDataset`. Contains all `getBill`/`getRollCall`/`getPerson` records as individual JSON files. Best for initial load. |

---

## All Pull Operations

| Operation | Input | Frequency | Description |
|---|---|---|---|
| `getSessionList` | `state` (optional) | Daily | Sessions for a state (or all states) |
| `getMasterList` | `state` OR `id`=session_id | 1 hour | Bill summary list with title, description, change_hash |
| `getMasterListRaw` | `state` OR `id`=session_id | 1 hour | Bill list with only bill_id, number, change_hash |
| `getBill` | `id`=bill_id | 3 hours | Full bill detail |
| `getBillText` | `id`=doc_id | Static | Base64-encoded bill text (PDF/HTML/etc) |
| `getAmendment` | `id`=amendment_id | Static | Base64-encoded amendment text |
| `getSupplement` | `id`=supplement_id | Static | Base64-encoded supplement (fiscal note, veto letter, etc) |
| `getRollCall` | `id`=roll_call_id | Static | Vote record with individual legislator votes |
| `getPerson` | `id`=people_id | Weekly | Legislator info + third-party IDs |
| `getSearch` | `state`+`query` OR `id`+`query`, optional `year`, `page` | 1 hour | Full-text search, 50 results/page |
| `getSearchRaw` | same as getSearch | 1 hour | Full-text search, **2000 results/page** — use for automation |
| `getDatasetList` | `state` (optional), `year` (optional) | Weekly | Available session ZIP datasets with access_key + dataset_hash |
| `getDataset` | `id`=session_id, `access_key`, `format`=json\|csv | Weekly | Full session ZIP (all bills+votes+people), base64-encoded |
| `getDatasetRaw` | same as getDataset | Weekly | Same ZIP as raw binary stream |
| `getSessionPeople` | `id`=session_id | Weekly | All legislators active in a session |
| `getSponsoredList` | `id`=people_id | Daily | All bills sponsored by a legislator |
| `getMonitorList` | `record`=current\|archived\|YEAR | 1 hour | GAITS watch list bills with full summary |
| `getMonitorListRaw` | `record`=current\|archived\|YEAR | 1 hour | GAITS watch list with only change_hash — efficient change detection |
| `setMonitor` | `list`=comma-separated bill_ids, `action`=monitor\|remove\|set, `stance`=watch\|support\|oppose | Live | Add/remove bills from GAITS monitor list |

**`getSearch` year parameter:** 1=all, 2=current (default), 3=recent, 4=prior, >1900=exact year  
**`getDataset` format:** json (default) or csv

---

## Recommended Sync Architecture

### Initial load (2–3 queries total)
```
1. getDatasetList&state=NJ         → get session_id, access_key, dataset_hash
2. getDataset&id=SESSION_ID&access_key=KEY  → ZIP with all getBill payloads
3. Unzip, run keyword filter, store ~258 election bills in D1
4. setMonitor&action=monitor&list=bill_id1,bill_id2,...  → add to watch list
5. Store dataset_hash for future comparison
```

### Incremental sync (2 + N queries)
```
1. getDatasetList&state=NJ    → check if dataset_hash changed (new bills introduced)
   If changed: re-download ZIP, find new bills, add to monitor list
2. getMonitorListRaw          → change_hash for all ~258 monitored bills
3. getBill&id=X  (only for bills whose change_hash changed)
```

### Pre-filter alternative (if not using Bulk)
```
getMasterList → keyword filter on title+description → getBill only for flagged bills
Cost: 1 + 258×1 = ~259 queries (vs 19,139 for all bills)
```

---

## Internal Identifiers

| ID | Used by |
|---|---|
| `session_id` | getMasterList, getMasterListRaw, getDataset, getSessionPeople |
| `bill_id` | getBill, setMonitor |
| `doc_id` | getBillText |
| `amendment_id` | getAmendment |
| `supplement_id` | getSupplement |
| `roll_call_id` | getRollCall |
| `people_id` | getPerson, getSponsoredList |

---

## getBill Response Fields

```json
{
  "bill_id": 2098324,
  "change_hash": "6585a125...",     // MD5 hash — store for change detection
  "session_id": 2250,
  "session": { "session_id", "state_id", "year_start", "year_end",
               "prefile", "sine_die", "prior", "special",
               "session_tag", "session_title", "session_name" },
  "url": "https://legiscan.com/NJ/bill/A114/2026",
  "state_link": "https://www.njleg.state.nj.us/bill-search/2026/A114",
  "completed": 0,                   // DEPRECATED — DO NOT USE
  "status": 1,                      // see Status/Progress enum
  "status_date": "2026-01-13",
  "progress": [{"date", "event"}],  // significant events only — maps to status
  "state": "NJ",
  "bill_number": "A114",
  "bill_type": "B",                 // see Bill Types enum
  "bill_type_id": 1,
  "body": "A",                      // originating chamber
  "current_body": "A",
  "title": "...",
  "description": "...",
  "pending_committee_id": 3085,
  "committee": { "committee_id", "chamber", "chamber_id", "name" },
  "referrals": [{ "date", "committee_id", "chamber", "chamber_id", "name" }],
  "history": [{ "date", "action", "chamber", "chamber_id", "importance" }],
  "sponsors": [{
    "people_id", "person_hash", "party_id", "party", "role_id", "role",
    "name", "first_name", "middle_name", "last_name", "suffix", "nickname",
    "district",
    "ftm_eid",          // FollowTheMoney.org
    "votesmart_id",     // VoteSmart.org
    "opensecrets_id",   // OpenSecrets (Congress only)
    "knowwho_pid",      // KnowWho.com
    "ballotpedia",      // Ballotpedia.org name
    "sponsor_type_id",  // see Sponsor Types enum
    "sponsor_order",
    "committee_sponsor", "committee_id",
    "bio": { "social": { "capitol_phone", "district_phone", "email", ... },
             "capitol_address": { "address1", "city", "state", "zip" },
             "links": { "official": {...}, "personal": {...} } }
  }],
  "sasts": [{
    "type_id",           // see SAST Types enum
    "type",              // "Same As", "Carry Over", etc.
    "sast_bill_number",  // e.g. "A3826"
    "sast_bill_id"
  }],
  "subjects": [{ "subject_id", "subject_name" }],   // LegiScan taxonomy (may be empty)
  "texts": [{
    "doc_id",            // use for getBillText
    "date", "type", "type_id",
    "mime", "mime_id",
    "url",               // LegiScan URL
    "state_link",        // direct state legislature URL
    "text_size",         // bytes of decoded base64 (add 33% for base64 size)
    "text_hash",         // MD5 — check before re-fetching
    "alt_bill_text",     // 1 if alternate format available
    "alt_mime", "alt_mime_id", "alt_state_link", "alt_text_size", "alt_text_hash"
  }],
  "votes": [{
    "roll_call_id", "date", "desc",
    "yea", "nay", "nv", "absent", "total", "passed",
    "chamber", "chamber_id", "url", "state_link"
  }],
  "amendments": [{ "amendment_id", "adopted", "chamber", "date", "title",
                   "description", "mime", "url", "state_link",
                   "amendment_size", "amendment_hash" }],
  "supplements": [{ "supplement_id", "date", "type_id", "type",
                    "title", "description", "mime", "url", "state_link",
                    "supplement_size", "supplement_hash" }],
  "calendar": [{ "type_id", "type", "date", "time", "location", "description" }]
}
```

---

## getMasterList Entry Fields
```json
{
  "bill_id": 2098324,
  "number": "A114",
  "change_hash": "6585a125...",
  "url": "https://legiscan.com/NJ/bill/A114/2026",
  "status_date": "2026-01-13",
  "status": 1,
  "last_action_date": "2026-01-13",
  "last_action": "Introduced, Referred to Assembly State and Local Government Committee",
  "title": "Allows candidates to file form...",
  "description": "Allows candidates to file form..."
}
```
Session info at `masterlist["session"]` key. Bills at `masterlist["0"]`, `masterlist["1"]`, etc. (numeric string keys).

## getMasterListRaw Entry Fields
```json
{ "bill_id": 2098324, "number": "A114", "change_hash": "6585a125..." }
```

---

## getMonitorList / getMonitorListRaw

`getMonitorList` returns same structure as getMasterList entries, plus `stance` field.  
`getMonitorListRaw` returns: `bill_id`, `state`, `number`, `stance`, `change_hash`, `status`.  
`record` param: `current` (default), `archived`, or exact year ≥2010.

`setMonitor` actions:
- `monitor` — add to list (stance defaults to watch)
- `remove` — remove from list
- `set` — update stance on existing monitored bills

---

## getDatasetList Response
```json
{
  "session_id": 2250,
  "state_id": 30,
  "year_start": 2026,
  "year_end": 2027,
  "session_name": "2026-2027 Regular Session",
  "dataset_hash": "...",     // changes when archive updates — store for comparison
  "dataset_date": "...",
  "dataset_size": 11958086,  // bytes
  "access_key": "3Qd0kRszXtZuRloonDQx63"  // required for getDataset
}
```

## getDataset Response
```json
{
  "state_id": 30, "session_id": 2250,
  "session_name": "...", "dataset_hash": "...", "dataset_date": "...",
  "dataset_size": 317775,
  "mime": "application/zip",
  "zip": "MIME 64 Encoded ZIP Archive"
}
```
ZIP contents: individual JSON files matching getBill/getRollCall/getPerson payloads for entire session.

---

## Static Value Enums

### Status / Progress
| Value | Status | Notes |
|---|---|---|
| 0 | N/A | Pre-filed |
| 1 | Introduced | |
| 2 | Engrossed | |
| 3 | Enrolled | |
| 4 | Passed | |
| 5 | Vetoed | |
| 6 | Failed | Limited state support |
| 7 | Override | Progress array only |
| 8 | Chaptered | Progress array only |
| 9 | Refer | Progress array only |
| 10 | Report Pass | Progress array only |
| 11 | Report DNP | Progress array only |
| 12 | Draft | Progress array only |

### SAST Types (bill relationships)
| Value | Type |
|---|---|
| 1 | Same As |
| 2 | Similar To |
| 3 | Replaced By |
| 4 | Replaces |
| 5 | Cross-filed |
| 6 | Enabling For |
| 7 | Enabled By |
| 8 | Related |
| 9 | Carry Over (from previous session) |

### Sponsor Types
| Value | Type |
|---|---|
| 0 | Sponsor (Generic/Unspecified) |
| 1 | Primary Sponsor |
| 2 | Co-Sponsor |
| 3 | Joint Sponsor |

### Bill Types
| Value | Type | | Value | Type |
|---|---|---|---|---|
| 1 | B — Bill | | 13 | P — Proclamation |
| 2 | R — Resolution | | 14 | SR — Study Request |
| 3 | CR — Concurrent Resolution | | 15 | A — Address |
| 4 | JR — Joint Resolution | | 16 | CM — Concurrent Memorial |
| 5 | JRCA — Joint Resolution Constitutional Amendment | | 17 | I — Initiative |
| 6 | EO — Executive Order | | 18 | PET — Petition |
| 7 | CA — Constitutional Amendment | | 19 | SB — Study Bill |
| 8 | M — Memorial | | 20 | IP — Initiative Petition |
| 9 | CL — Claim | | 21 | RB — Repeal Bill |
| 10 | C — Commendation | | 22 | RM — Remonstration |
| 11 | CSR — Committee Study Request | | 23 | CB — Committee Bill |
| 12 | JM — Joint Memorial | | | |

### MIME Types
| Value | Type | Extension |
|---|---|---|
| 1 | HTML | .html |
| 2 | PDF | .pdf |
| 3 | WordPerfect | .wpd |
| 4 | MS Word | .doc |
| 5 | Rich Text Format | .rtf |
| 6 | MS Word 2007 | .docx |

### Supplement Types
| Value | Type |
|---|---|
| 1 | Fiscal Note |
| 2 | Analysis |
| 3 | Fiscal Note/Analysis |
| 4 | Vote Image |
| 5 | Local Mandate |
| 6 | Corrections Impact |
| 7 | Miscellaneous |
| 8 | Veto Letter |

### Text Types
| Value | Type |
|---|---|
| 1 | Introduced |
| 2 | Committee Substitute |
| 3 | Amended |
| 4 | Engrossed |
| 5 | Enrolled |
| 6 | Chaptered |
| 7 | Fiscal Note |
| 8 | Analysis |
| 9 | Draft |
| 10 | Conference Substitute |
| 11 | Prefiled |
| 12 | Veto Message |
| 13 | Veto Response |
| 14 | Substitute |

### Roles
| Value | Description |
|---|---|
| 1 | Representative / Lower Chamber |
| 2 | Senator / Upper Chamber |
| 3 | Joint Conference |

### Political Party
| Value | Party |
|---|---|
| 1 | Democrat |
| 2 | Republican |
| 3 | Independent |
| 4 | Green Party |
| 5 | Libertarian |
| 6 | Nonpartisan |

### Stance (Monitor List)
| Value | Description |
|---|---|
| 0 | Watch |
| 1 | Support |
| 2 | Oppose |

### Votes
| Value | Description |
|---|---|
| 1 | Yea |
| 2 | Nay |
| 3 | Not Voting / Abstain |
| 4 | Absent / Excused |

### Push API Reasons (flags in `reasons[]` array)
| Value | Flag | Description |
|---|---|---|
| 1 | Newbill | New legislation |
| 2 | StatusChange | Status changed |
| 3 | Chamber | Moved chambers |
| 4 | Complete | DEPRECATED |
| 5 | Title | Title changed |
| 6 | Description | Description changed |
| 7 | CommRefer | Referred/re-referred to committee |
| 8 | CommReport | Reported from committee |
| 9 | SponsorAdd | Sponsor added |
| 10 | SponsorRemove | Sponsor removed |
| 11 | SponsorChange | Existing sponsor position/type changed |
| 12 | HistoryAdd | New history steps |
| 13 | HistoryRemove | History steps removed |
| 14 | HistoryRevised | Prior history steps revised |
| 15 | HistoryMajor | History changes included major steps |
| 16 | HistoryMinor | History changes included minor steps |
| 17 | SubjectAdd | Subject added |
| 18 | SubjectRemove | Subject removed |
| 19 | SAST | New SAST bill associated |
| 20 | Text | New bill text document |
| 21 | Amendment | New amendment document |
| 22 | Supplement | New supplement document |
| 23 | Vote | New vote record |
| 24 | Calendar | New/updated calendar event |
| 25 | Progress | Progress array updated |

---

## NJ-Specific Findings (from live API calls, April 2026)

- **NJ session_id:** `2250` (2026-2027 Regular Session)
- **NJ state_id:** `30`
- **Total bills in session:** ~9,569
- **LegiScan subject taxonomy for NJ:** uses `"State and Local Government"` for election bills — NOT `"Elections"`. Subject filtering is not useful for NJ election bill identification.
- **Our keyword filter recall:** 91.5% vs NCSL ground truth (258 flagged, 193 true positives, 18 false negatives)
- **False negative patterns:** "elective" vs "election", "to vote", "ELEC" (NJ Election Law Enforcement Commission), "nominating petition", "electoral college", "recall election"

### Recommended keyword additions
Add to `api/src/lib/keywords.ts`:
- `'nominating petition'` — catches A114, A115, S3203, A2682, A3000
- `'electoral college'` — catches A501, S1735
- `'elective office'` — catches SCR70, A3897
- `'recall election'` — catches S463
- `'popular vote'` — backup for electoral college bills

### Sample real NJ election bills (session 2250)
| Bill | bill_id | Title |
|---|---|---|
| A114 | 2098324 | Allows candidates to file form attesting to ELEC rules with nominating petitions |
| A115 | 2096087 | Requires blank nominating petition forms for primary election candidates |
| A125 | 2098997 | Requires automatic recount for local elections ≤10 vote difference |
| A136 | 2096969 | Requires notice upon voter registration changes; prohibits late party affiliation changes |
