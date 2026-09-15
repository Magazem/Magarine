# Magarine — Batch 14: the interface, for the owner's eye

Author: Strategist. Date: 2026-09-15. Follows `docs/evidence/batch-13-walk/RESULT.md`. Shaped in messages before batch 13 closed; recorded here with two rulings added after the owner's first look.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. Where things stand
- Batch 13 closed: the same scope that left the folder empty now delivers four files, the proposal cannot contain a workspace choice, and every DONE row shows what it produced. The adversarial case, a worker describing instead of writing, stays open and named as a judgement case; one run behaved, which proves nothing.
- Batch 14 step 1 has run twice. The owner approved the layout and interaction and rejected the first visual pass as generic. Two causes named by the Orchestrator: the design capability was never queried because the assistant spawned without its skills, and my own "system fonts only" instruction.

## 1. Rulings

### 1. The no-build constraint stays; the font restriction was mine and is lifted in the only way that keeps the constraint.
Fonts may be shipped as files under `ui/` and served by the daemon like the page itself. No request ever leaves the loopback address, nothing is installed, nothing is built. What stays forbidden is fetching anything from the network at runtime. The same applies to icons: inline or local files only.

Amendment after the designer's review: a served font that fails to load falls back silently to a system font and the page quietly becomes the generic thing the owner rejected, which is this project's recurring shape, a wrong outcome reporting success, arriving through a door this ruling opened. So the served-file route carries three guards, all in the spec rather than left to implementation: a test that the font route answers 200 with `content-type: font/woff2`; `doctor` fetching every asset route on a real install and printing PASS or FAIL per asset; and the page itself checking font readiness through the browser's font-loading interface and showing a small visible notice, "interface font did not load, run magarine doctor", when it fails. A silent fallback on the page is not allowed; the page must say when it is not the page the owner approved. The designer's other calls stand: one `@font-face` block per subset with its own `unicode-range` from the start, base64 only in the mocks that are opened from disk, and inline SVG with `currentColor` over any icon font.

### 2. A role that needs a capability is spawned with it, verified before its first task.
The designer ran without the design database it was hired to use. From now on the Orchestrator reads the assistant back after spawning and confirms every capability the brief names is attached before dispatching the first task. One line in each close-out says it was done.

### 3. Batch 15 carries one small item from the adversarial case: expected artefacts on tickets.
The Manager's envelope asks that each ticket's acceptance criteria name the artefacts it must produce, kind and path, as a structured `expected_artifacts` list on `create_ticket` and `update_ticket`. When a ticket declares them, DONE is verified against them, not only against "at least one". A ticket that asks for a file and receives a description is then a mechanical failure, not a judgement call. Tickets without the list keep today's rule. Not for batch 14.

## 2. Batch 14 as shaped
One role, Interface Designer-Engineer, sonnet high, design capability attached and verified. Step 1, the one-page brief and mocked screens approved by the owner through the Liaison, is where the owner's eye is applied early. Step 2 is the implementation in `ui/` under the vanilla rule with local assets. The artefact display branches on kind: paths for files, short chips for text-bearing kinds, never the whole text inline in a table cell.
Acceptance beyond the owner's yes: keyboard reachable, readable at 100 and 125 percent scaling, dark and light, no layout break on a long inbox reason or long scope, existing page tests pass, screenshots at each stage, and the owner's own walk on the new page closes the batch.

## 3. What the owner must decide or supply
Their second look at the reskin, through the Liaison; then references whenever they like. Nothing else blocks.
