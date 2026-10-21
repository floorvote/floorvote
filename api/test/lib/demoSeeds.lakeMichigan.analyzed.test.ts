import { describe, it, expect } from 'vitest'
import { DEMO_SEEDS } from '../../src/lib/demoSeeds'
import { LM_NO_PRIORITY_ACTIONS } from '../../src/lib/demoSeeds/lakeMichigan/bills'
import { matchesKeywords, billMatchText } from '../../../shared/keywords'

/**
 * The demo's bills with no priority get a daily row on the feed (#918, seeded by
 * #925), but the row, and the reset that writes it, count only bills the instance has
 * analyzed: a bill with a match type. The demo's central delivers the whole LegiScan
 * sample, and a bill is analyzed only when it matches the demo's keywords (the same
 * test the queue processor runs, `matchesKeywords` over title, abstract, and bill
 * number). The first dozen bills the seed used matched none of them, so none was
 * analyzed on the live demo and the row never appeared.
 *
 * The sample is not in the repository, so each bill's matched text is pinned below,
 * as the sample gives it: title, description (the abstract), and bill number. Adding
 * a bill to `LM_NO_PRIORITY_ACTIONS` takes an entry here, and the entry has to match.
 * A bill that does not match the keywords can still be analyzed on the demo (a
 * companion group can pull one in), but nothing here can show that, so a bill that
 * matches is the safe pick. The demo sets no `new_match_min_relevance`, so the
 * default of 0 applies and no relevance floor keeps an analyzed bill out.
 */
const SAMPLE_TEXT: Record<string, { number: string; title: string; description: string }> = {
  "legiscan:2104855": {
    number: "SB3309", // IL SB3309
    title: "$DNR-GRANTS-WETLANDS",
    description: "Appropriates $2,000,000 to the Department of Natural Resources for grants to fund wetland protection, enhancement, and restoration projects. Effective July 1, 2026.",
  },
  "legiscan:2065195": {
    number: "HB1239", // IN HB1239
    title: "PFAS water safety standards.",
    description: "PFAS water safety standards. Requires the Indiana department of health (state department) to establish state maximum contaminant levels for PFAS in water provided by public water systems. Provides that maximum contaminant levels established by the state department: (1) must be protective of public health, including the health of vulnerable subpopulations; and (2) may not be less stringent than any maximum contaminant level or health advisory promulgated by the United States Environmental Protection Agency.",
  },
  "legiscan:2065523": {
    number: "HB1297", // IN HB1297
    title: "Water intensive facilities.",
    description: "Water intensive facilities. Provides that if a proposed economic development project includes proposed construction or establishment of a facility that will consume an average of at least 500,000 gallons of water per day in ordinary operation (water intensive facility), the Indiana finance authority (IFA) may not approve a bid for the project, the Indiana economic development corporation (IEDC) may not grant a job creation incentive for the project, and a local unit may not provide financing for the project unless the IFA, IEDC, or local unit: (1) provides notice of the proposed water intensive facility to the water utility that provides water utility service to the proposed location of the water intensive facility; (2) receives from the water utility a plan for provision of water utility service to the water intensive facility; (3) determines that the water utility's plan adequately ensures that: (A) the water utility can reliably meet both the ordinary and peak water demand of the water intensive facility; and (B) incremental costs of supplying water to the water intensive facility will be allocated to and paid by the water intensive facility; and (4) provides the water utility's plan to the local plan commission.",
  },
  "legiscan:2135407": {
    number: "SB0855", // MI SB0855
    title: "Appropriations: department of environment, Great Lakes, and energy; appropriations for fiscal year 2026-2027; provide for. Creates appropriation act.",
    description: "Appropriations: department of environment, Great Lakes, and energy; appropriations for fiscal year 2026-2027; provide for. Creates appropriation act.",
  },
  "legiscan:2061495": {
    number: "HB1110", // IN HB1110
    title: "PFAS chemicals.",
    description: "PFAS chemicals. Requires the department of environmental management to adopt maximum contaminant levels for PFAS chemicals and effluent limitation standards for wastewater containing PFAS chemicals by July 1, 2027. Creates various compliance requirements for direct dischargers and indirect dischargers. Establishes various civil penalties. Establishes the PFAS chemical testing and remediation fund. Creates a PFAS chemical grant program.",
  },
  "legiscan:2155128": {
    number: "HB6143", // MI HB6143
    title: "Natural resources: Great Lakes; regulations regarding crib docks in the Les Cheneaux Islands; prohibit Amends 1994 PA 451 (MCL 324.101 - 324.90106) by adding secs. 32509a & 32509b & provides for a referendum.",
    description: "Natural resources: Great Lakes; regulations regarding crib docks in the Les Cheneaux Islands; prohibit Amends 1994 PA 451 (MCL 324.101 - 324.90106) by adding secs. 32509a & 32509b & provides for a referendum.",
  },
  "legiscan:2041821": {
    number: "SB0505", // MI SB0505
    title: "Environmental protection: hazardous products; Michigan statewide microplastics strategy; establish. Amends 1994 PA 451 (MCL 324.101 - 324.90106) by adding pt. 151.",
    description: "Environmental protection: hazardous products; Michigan statewide microplastics strategy; establish. Amends 1994 PA 451 (MCL 324.101 - 324.90106) by adding pt. 151.",
  },
  "legiscan:2153386": {
    number: "HB6066", // MI HB6066
    title: "Environmental protection: sewage; onsite wastewater treatment systems; regulate, and provide for assessments and evaluations. Amends secs. 12751, 12752, 12757 & 12771 of 1978 PA 368 (MCL 333.12751 et. seq.) & adds pt. 128.",
    description: "Environmental protection: sewage; onsite wastewater treatment systems; regulate, and provide for assessments and evaluations. Amends secs. 12751, 12752, 12757 & 12771 of 1978 PA 368 (MCL 333.12751 et. seq.) & adds pt. 128.",
  },
  "legiscan:2144527": {
    number: "HB5842", // MI HB5842
    title: "Environmental protection: groundwater contamination; annual appropriation for certain geological survey work; direct legislature to make. Amends sec. 60108 of 1994 PA 451 (MCL 324.60108).",
    description: "Environmental protection: groundwater contamination; annual appropriation for certain geological survey work; direct legislature to make. Amends sec. 60108 of 1994 PA 451 (MCL 324.60108).",
  },
  "legiscan:1928265": {
    number: "SB0117", // IL SB0117
    title: "PFAS PRODUCT BAN",
    description: "Amends the PFAS Reduction Act. Provides that, beginning January 1, 2026, a person may not sell, offer for sale, or distribute for sale in this State the following products if the product contains intentionally added PFAS: (1) cookware, (2) cosmetics, (3) dental floss, (4) juvenile products, (5) menstrual products, (6) intimate apparel, or (7) food packaging or food contact products. Defines terms.",
  },
  "legiscan:2035723": {
    number: "HB4568", // MI HB4568
    title: "Appropriations: department of environment, Great Lakes, and energy; appropriations for fiscal year 2025-2026; provide for. Creates appropriation act.",
    description: "Appropriations: department of environment, Great Lakes, and energy; appropriations for fiscal year 2025-2026; provide for. Creates appropriation act.",
  },
  "legiscan:2156259": {
    number: "HB9836", // US HB9836
    title: "REPLACE Act Removing Existing Pipes with Lead and Advancing Clean Environments Act",
    description: "To amend the Residential Lead-Based Paint Hazard Reduction Act of 1992 and the Safe Drinking Water Act to modernize existing lead hazard reduction authorities, strengthen local implementation capacity, and improve coordination between housing and drinking water lead reduction efforts, and for other purposes.",
  },
}

describe('the bills with no priority that the demo seeds', () => {
  const keywords = DEMO_SEEDS['lake-michigan'].keywords
  const seededBills = [...new Set(LM_NO_PRIORITY_ACTIONS.map(a => a.externalId))]

  it('has the demo keywords to test them against', () => {
    expect(keywords.length).toBeGreaterThan(0)
    expect(seededBills.length).toBeGreaterThan(0)
  })

  it('pins the matched text of every bill it seeds, and of no other', () => {
    expect(Object.keys(SAMPLE_TEXT).sort()).toEqual([...seededBills].sort())
  })

  it('seeds only bills the demo would analyze, because the row counts no other', () => {
    const unmatched = seededBills.filter(ext => {
      const t = SAMPLE_TEXT[ext]
      return !t || !matchesKeywords(billMatchText({ title: t.title, description: t.description, billNumber: t.number }), keywords)
    })
    expect(unmatched, 'bills no demo keyword matches, so the demo never analyzes them').toEqual([])
  })
})
