# Magarine — Batch 14 addendum 3: ruling 9 amended

Author: Strategist. Date: 2026-09-16. Written after reading ruling 9 as recorded in addendum 2, `docs/design/pass3/BRIEF.md` section 3, and the generator inline in `docs/design/pass3/1-fleet-and-board.html`, from the tier trait table through the end of the `organism()` function, as delivered in the working tree and read before pass 3's first commit; the defect in section 5 is not present in any commit, because it was found and fixed before the first one (all HARD), and after running that generator under node over 2000 seeds per tier with the DOM render loop removed and nothing else changed (HARD). The Orchestrator reproduced the run independently against a hash-checked snapshot of the page and got the same result to within seed-string choice (HARD, their figures quoted below).
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. Why this addendum exists

The Designer built the batch 14 generator with the model tier selecting all three shape parameters, family, symmetry and density, by construction. Ruling 9 had said tier sets palette and density, purpose sets family, policy sets symmetry. Batch 14 has no purpose and no policy, so the Designer substituted. The Orchestrator, correctly, put the substitution to me rather than deciding it, and brought a measurement of their own: density scatters within a tier.

Three things came out of reviewing it. The substitution is right. Density is not a signal and my ruling should not have called it one. And the generator has a defect that makes its central promise, symmetry by construction, false for most seeds. This addendum records all three and supersedes the identity-layer paragraph of ruling 9 wherever the two disagree.

## 1. The substitution stands

Tier selects family and symmetry by construction, not from the hash.

Ruling 9's intent for batch 14, in its own words, was that "four tiers give four stable organisms." Drawing family and symmetry from a hash of the tier string is one coin flip per tier on whether the four come out distinct. The Designer's first cut did exactly that, and two tiers came out looking alike. Choosing by construction honours the intent; the hash did not. Batch 15 replaces two lookups, purpose for family and policy for symmetry, and nothing else in the substitution needs unwinding.

## 2. Density is struck from the identity claim

The Designer's stated payoff for the substitution was that "a dense quad-symmetric organism is an Opus worker." The quad half holds. The dense half does not, and cannot as built, because density is a per-cell probability weight against a 6..19 clamp, not a count.

Lit-cell counts over 2000 seeds per tier (HARD, my run):

| tier | min | p10 | median | p90 | max |
|---|---|---|---|---|---|
| fable | 11 | 19 | 19 | 19 | 19 |
| opus | 6 | 9 | 15 | 19 | 19 |
| sonnet | 6 | 9 | 13 | 17 | 19 |
| haiku | 6 | 6 | 8 | 12 | 19 |

Opus and sonnet overlap almost entirely. Haiku reaches the ceiling. Batch 14 shows one seed per tier, so the screens today are fine by luck; batch 15 gives every agent its own seed and this scatter becomes the default.

I am striking density rather than re-engineering it into a deterministic count, for three reasons. A 5x5 grid under symmetry reaches lit counts only in coarse steps, so four bands are marginally legible at 18px even if exact. The family bias already pulls natural density in different directions for ring, core and lattice, so tier and family would fight over the same channel. And the tier is already printed on the fleet row and priced in the cost column. The organism's job is *which agent*, not *which price*.

Density may remain in the generator as a soft weight if the Designer wants it. No document, page comment, brief, or table may call it a signal. If the tier table keeps a density column, the column is labelled as a weight.

## 3. Palette: correcting my own ruling

Ruling 9 said the model tier sets palette. It does not, and it should not. The Designer's channel allocation in `BRIEF.md` section 2 gives colour to status, one colour per ticket, inherited, and the pages do exactly that: every organism takes its colour from the ticket's status variable (HARD). That is the owner's own `agent-glyph.tsx` rule, identity is shape, activity is motion, status is colour, and it is right. I should have said so in addendum 2 instead of handing palette to the tier. The correction is mine.

## 4. The honest statement, to be used everywhere

- **Batch 14.** Tier = family + symmetry. Status = colour. The cell draw comes from the tier string's hash, so one tier is one organism.
- **Batch 15.** Purpose = family. Policy = symmetry. Name-hash = the individual cell draw. Status = colour. The tier has no channel in the organism after batch 15, by design; it lives on the fleet row and in the cost column.

Any wording that says tier sets palette, or that density identifies anything, is superseded by this section.

## 5. The defect: symmetry by construction is false today

The generator's clamp loop, which pulls the lit count back into 6..19 after the weighted fill, writes `cells[idx] = want` directly instead of going through the `put()` helper that mirrors a cell to its symmetric partners (HARD). Every time the clamp fires it breaks the symmetry the tier promised.

Symmetry-check failures over 2000 seeds per tier:

| tier | my run | Orchestrator's run |
|---|---|---|
| fable | 1549 / 2000 | 1526 / 2000 |
| opus | 265 / 2000 | 279 / 2000 |
| sonnet | 44 / 2000 | 33 / 2000 |
| haiku | 304 / 2000 | 299 / 2000 |

Fable is the worst case for a second reason. Its density weight of 12 plus the ring bias lights nearly every cell, so the clamp fires almost always and the result is a near-full blob with random single cells knocked out. It is not a ring and it is not quad. The hand-picked seeds the team had checked all happened to land inside the clamp band, so the loop never fired and the defect was invisible. Five seeds by hand is not a measurement.

This blocks the pass 3 commit. It is the same rule as addendum 2's ruling 1 applied to the design's own claims: a page that says "by construction" must be true for every seed, not for the seeds on the page.

## 6. Acceptance criteria for the fix

Designer, sonnet tier. The Orchestrator verifies each line before the commit.

1. Symmetry holds for 100% of seeds, verified by an automated check over at least 1000 seeds per tier, node or in-page, committed next to the pages. Not seeds by hand.
2. Every lit count lands in 6..19 with no code path writing a single cell outside `put()`. Either the clamp goes through `put()` over orbit representatives, or the clamp is replaced by a fill that reaches a valid count directly. The Designer chooses; both are acceptable.
3. Fable's traits are retuned so its median lit count is not pinned at the ceiling. A ring must read as a ring.
4. The generator version stays `mg.v1`. Nothing has shipped, so no avatar exists to restyle.
5. `BRIEF.md` section 3 and the generator header comment in each page, the one that restates ruling 9's parameters above the tier trait table, are restated per section 4 above, with density removed from the identity claim.

## 7. What does not change

Ruling 9's two-layer design, identity stable and activity moving on a real `worker_progress` event only, is untouched. The route in addendum 2 is untouched. Batch 15 still brings worker profiles with their own seeds; it inherits the generator as fixed here, and the two lookup swaps in section 4 are its whole change to it.
