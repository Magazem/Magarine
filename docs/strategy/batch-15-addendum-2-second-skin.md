# Magarine — Batch 15 addendum 2: the owner's proposal is a second skin, carried, and the page is built so it can exist

Author: Strategist. Date: 2026-09-16. Follows `batch-15-addendum-owner-answers.md`. The owner's words are as relayed by the Liaison through the Orchestrator (SOFT: I did not read the Liaison tab).
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What the owner said

Pass 3 is approved: "the design is good, we will use it." The small real run is permitted. And: "the one i proposed was also good, so we use the one the designer did now and later stages after we have the product working we add an extra theme from the one i proposed, I DON'T WANT IT LOST."

The Orchestrator verified `propos/` is fully tracked, 119 files, reference image in HEAD (HARD, theirs). Loss by deletion is not the risk. The risk is that nobody ever builds it. This addendum makes that a carried item with a trigger and makes the page Role B is about to build unable to forbid it.

## 1. Ruling 13 — it is a skin, not a palette

The owner called it "an extra theme". Pass 3's `tokens.css` already carries three themes, and they vary colour only (oled, dark, paper). The owner's proposal varies more than colour:

- The owner's plain HTML (HARD, `propos/12ui-5132548c-....html`, about 1 MB) has the same regions as pass 3: agents, board, a board filter, needs-you, conversation, activity. Same product, as the owner's own brief demands: "we are changing the VISUAL LANGUAGE, not the PRODUCT."
- It arranges them by absolute positioning with a different visual language, and it carries decorative elements pass 3 deliberately has none of (HARD, case-insensitive occurrence counts in the file: "avatar" 26, "mascot" 1, "Caveat", the handwriting typeface, 5; the word "handwriting" itself does not appear. An earlier version of this sentence gave 32, which was the number of lines matching any of those three terms, not the number of references, and named handwriting where the file names the typeface).

Same regions, different arrangement, different language, extra decoration. That is a **skin**. "Add it later as a theme" is therefore not a token swap. It is a second stylesheet and token set that must be able to restyle, respace, retype and **rearrange** the same regions and add decoration by CSS, without touching the page's structure or script.

## 2. What Role B builds now so that is true, and what it costs

These are requirements on the page in batch 15. They replace the Orchestrator's holding instruction to Role B, which was correct and is now made concrete.

1. **Regions are named, semantic and stable.** `index.html` carries the six product regions as containers with fixed ids: `fleet`, `board`, `needs-you`, `scope`, `conversation`, `activity`. A skin addresses regions by these ids and nothing else.
2. **Placement lives in the skin, not the markup.** Region arrangement is done by CSS grid areas in the skin stylesheet. A second skin may rearrange regions by changing the areas alone. No layout wrapper `div` exists only to serve pass 3's arrangement.
3. **Script sets state, never style.** `app.js` writes text, `data-*` attributes and semantic ids. It never writes inline styles and never sets presentational class names. One test proves it: `app.js` contains no `style=`, no `.style.`, and no class name from a constant list of presentational words the test owns (colour, size, spacing, position words). The test is mutation-checked like every other.
4. **Two independent switches on the root.** `data-theme` is palette, as pass 3 has it. `data-skin` is visual language, default `brutalist`, the only value shipped. Skin stylesheets are `ui/skin-<name>.css`; the page loads the one the root names. One skin ships in batch 15.
5. **The organism is product, not skin.** `organism.js` and the identity rules (shape is identity, motion is activity, colour is status) hold under every skin. A skin restyles the organism's container and scale and may not touch its cells, its symmetry or its animation rule. The owner's cartoon avatars and mascot are exactly what their own brief forbids and what ruling 9 replaced; the second skin gets the same organisms in its own dress.
6. **Rule 8 applies to every skin.** A skin shows what the daemon measures and nothing else. Decoration by CSS is allowed; invented data is not, in any skin.

Cost to batch 15: an attribute, a naming rule, a grid-areas discipline Role B would mostly follow anyway, and one grep-style test. Nearly free before the page is written; a rewrite of `index.html` the day after.

## 3. What a second skin can and cannot do, stated so nobody is surprised later

Can: recolour, retype, respace, re-border, rearrange the six regions, add decorative elements and annotations by CSS, change density and rhythm. Cannot: add product elements, show data the daemon does not have, replace the organisms, or alter what a state means. If the owner's proposal turns out to need a product element pass 3 lacks, that is a product change ruled on its own merits at the time, not smuggled in as a skin.

## 4. Carried item, with the trigger in the owner's words

"Add an extra theme from the one I proposed, after we have the product working." Concretely: not before the Windows window host closes, batch 17. It enters the route as a candidate for batch 18 beside per-ticket discussion, tags and shortcuts, and it is listed in the handover's carried items with the owner's words and the source: the owner's plain HTML and reference image under `propos/`, which are the owner's own liking and are authoritative for this skin. The Next.js port under `propos/fleet-and-board/` remains what addendum 1 ruled it: a generator's artefact, not the owner's preference.

## 5. Not blocked

Role B runs. Role A runs. The unicode-range correction the Orchestrator asked for is already on disk in addendum 1; the messages crossed.
