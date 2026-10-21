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
  "legiscan:2107488": {
    number: "SB3381", // IL SB3381
    title: "WATER COMMISSION-CONSTRUCTION",
    description: "Deletes a provision concerning a waterworks system or a common source of supply of water, or both, and the parameters of its purchase or construction. Makes other technical and conforming changes.",
  },
  "legiscan:2152881": {
    number: "HB6038", // MI HB6038
    title: "Environmental protection: permits; deadline for the department to require changes to an application for certain permits; provide. Amends sec. 30306 of 1994 PA 451 (MCL 324.30306).",
    description: "Environmental protection: permits; deadline for the department to require changes to an application for certain permits; provide. Amends sec. 30306 of 1994 PA 451 (MCL 324.30306).",
  },
  "legiscan:1961471": {
    number: "HB3433", // IL HB3433
    title: "DNR-FLOOD RISK REDUC PIL PROJ",
    description: "Amends the Department of Natural Resources (Conservation) Law of the Civil Administrative Code of Illinois. Provides that, subject to appropriation, the Department of Natural Resources shall design, implement, and evaluate not more than 3 demonstration projects that test natural flood risk reduction practices in flood-prone areas of the State, as determined by the Department, with certain requirements. Provides that the Department may require a county to submit to the Department a progress report with certain information. Provides that the Department shall submit to the General Assembly and to the Illinois Emergency Management Agency and Office of Homeland Security a report with certain information. Allows the Department to adopt rules.",
  },
  "legiscan:2029663": {
    number: "HB4477", // MI HB4477
    title: "Education: curriculum; instruction in water safety; require. Amends 1976 PA 451 (MCL 380.1 - 380.1852) by adding sec. 1170c.",
    description: "Education: curriculum; instruction in water safety; require. Amends 1976 PA 451 (MCL 380.1 - 380.1852) by adding sec. 1170c.",
  },
  "legiscan:2067187": {
    number: "HB1398", // IN HB1398
    title: "Agricultural programs.",
    description: "Agricultural programs. Creates the pork market development program (pork program) and the soybean market development program (soybean program). Specifies that the pork program and soybean program apply only if assessments are not levied and collected under federal law. Requires the Indiana Pork Producers Association, Inc., to administer the pork program and the Indiana Soybean Alliance to administer the soybean program. Establishes various procedures and requirements for operating the pork program and the soybean program. Makes technical corrections.",
  },
  "legiscan:2101857": {
    number: "HB5485", // MI HB5485
    title: "Natural resources: inland lakes; dam safety regulations; provide for. Amends secs. 31502, 31503, 31504, 31505, 31506, 31507, 31508, 31509, 31510, 31511, 31513, 31515, 31516, 31517, 31518, 31520, 31521 & 31523 of 1994 PA 451 (MCL 324.31502 et seq.) & adds secs. 31506a, 31509a, 31509b, 31517a, 31518a, 31518b, 31518c, 31518d, 31528a & 31528b.",
    description: "Natural resources: inland lakes; dam safety regulations; provide for. Amends secs. 31502, 31503, 31504, 31505, 31506, 31507, 31508, 31509, 31510, 31511, 31513, 31515, 31516, 31517, 31518, 31520, 31521 & 31523 of 1994 PA 451 (MCL 324.31502 et seq.) & adds secs. 31506a, 31509a, 31509b, 31517a, 31518a, 31518b, 31518c, 31518d, 31528a & 31528b.",
  },
  "legiscan:1961538": {
    number: "HB3457", // IL HB3457
    title: "LAND CONSERVATION INCENTIVES",
    description: "Provides that the amendatory Act may be referred to as the Land Conservation Incentives Act. Amends the Illinois Income Tax Act. Provides that, for taxable years beginning on or after January 1, 2025, there is a tax credit of up to $200,000 with respect to qualified real property interest conveyed for conservation and preservation purposes as the qualified donation by the taxpayer, with certain requirements. Provides that any taxpayer claiming this tax credit may not claim a credit under any similar law for costs related to the same project. Provides that any tax credits from the donation of an interest in land made by a pass-through tax entity such as a trust, estate, partnership, limited liability corporation or partnership, limited partnership, S corporation, or other fiduciary shall be used either by such entity if it is the taxpayer on behalf of such entity or by the member, manager, partner, shareholder, or beneficiary, as the case may be, in proportion to their interest in such entity if the income, deductions, and tax liability passes through such entity to such member, manager, partner, shareholder, or beneficiary, and that such tax credits may not be claimed by both the entity and the member, manager, partner, shareholder, or beneficiary for the same donation. Requires the Department of Natural Resources and Department of Revenue to adopt rules. Defines terms. Makes findings.",
  },
  "legiscan:2111379": {
    number: "HB5593", // IL HB5593
    title: "LAND CONSERVATION ACT",
    description: "Creates the Agricultural Land Conservation Act. Provides that, beginning on January 1, 2027, a Farmland Conversion Fee of $275 per acre shall be paid by the buyer or lessee of a transaction for any agricultural land that will be removed from production for the specific purpose of developing an industrial park, a commercial area, a single-family or multi-family dwelling or for being put to any other use that removes the agricultural land from production. Provides that the fee shall be collected by the Department of Agricultural. Provides for the creation of the Farmland Conversion Fee Fund as a special fund in the State Treasury. Provides that all Farmland Conversion Fees collected by the Department of Agriculture shall be contributed to the Fund. Further provides that moneys in the Fund may be exclusively used for the following purposes: (i) supporting education and programs that support healthy soil clean water, and climate-smart agricultural practices; (ii) supporting operations funding for soil and water conservation districts; (iii) covering costs associated with administering the Act; (iv) any other purposes that the Department of Agriculture determines are consistent with the purposes of the Act. Provides that, before expending moneys for any other purposes, the Department of Agriculture shall, subject to the availability of moneys in the Fund, ensure that during each State fiscal year, $10,000,000 is distributed to soil and water conservation districts, for the purpose of supporting their operations funding. Provides that $500,000 shall be distributed to the Department of Agriculture for the purposes of collecting fees and administering the program created under the Act. Provides for penalties. Effective immediately.",
  },
  "legiscan:2038872": {
    number: "HB4708", // MI HB4708
    title: "Watercraft: marinas; enforcement of liens; modify. Amends sec. 5 of 1998 PA 362 (MCL 570.375).",
    description: "Watercraft: marinas; enforcement of liens; modify. Amends sec. 5 of 1998 PA 362 (MCL 570.375).",
  },
  "legiscan:1945910": {
    number: "HB1873", // IL HB1873
    title: "PUBLIC ACCESS-NAVIGABLE WATERS",
    description: "Amends the Rivers, Lakes, and Streams Act. Provides that the public right to access and use navigable waters includes all rights recognized by State or federal law, including the rights set forth in the Northwest Ordinance of 1787 and the federal navigational servitude, and all rights arising under the public trust doctrine, which shall be understood and applied in a manner consistent with the spirit of the Act to maximize the full and free enjoyment of State waters by the public. Provides that any segment of a lake, river, or stream that is capable of supporting use by commercial or recreational watercraft for a substantial part of the year, or that is actually so used, shall be deemed navigable, and shall be open to public access and use, unless the contrary is proven in litigation by a preponderance of the evidence. Provides that public uses in such waters shall include boating, tubing, fishing, swimming, and wading. Requires the Department of Natural Resources to protect such public uses against interference or encroachment as provided in the Act. Provides that no action or inaction by the Department of Natural Resources shall create a presumption, in any civil or criminal litigation, against the navigability of any waterway segment. Provides that the public right to access and use navigable waters shall be subject to specified protections and limitations, a violation of which shall be punished as otherwise provided by law, and, if likely to continue, enjoined by a court of competent jurisdiction. Provides that nothing in the Act shall limit the right of any person to challenge the legality of alleged interference with the public right to access or use navigable waters in any appropriate civil or criminal litigation.",
  },
  "legiscan:2027870": {
    number: "SB1523", // US SB1523
    title: "Water Research Optimization Act of 2025",
    description: "A bill to modify operations of the National Water Center of the National Oceanic and Atmospheric Administration, and for other purposes.",
  },
  "legiscan:2025978": {
    number: "SB0246", // MI SB0246
    title: "Environmental protection: hazardous waste; environmental protection; landfills; disposal fees; increase, and limit certain disposal wells and TENORM disposal. Amends secs. 11102, 11103, 11104, 11108, 11109, 11110, 11125, 11132, 11514b, 11525a, 62501 & 62509 of 1994 PA 451 (MCL 324.11102 et seq.); adds secs. 11122, 62508b & 62509d & repeals secs. 11111 & 11112 of 1994 PA 451 (MCL 324.11111 & 324.11112).",
    description: "Environmental protection: hazardous waste; environmental protection; landfills; disposal fees; increase, and limit certain disposal wells and TENORM disposal. Amends secs. 11102, 11103, 11104, 11108, 11109, 11110, 11125, 11132, 11514b, 11525a, 62501 & 62509 of 1994 PA 451 (MCL 324.11102 et seq.); adds secs. 11122, 62508b & 62509d & repeals secs. 11111 & 11112 of 1994 PA 451 (MCL 324.11111 & 324.11112).",
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
