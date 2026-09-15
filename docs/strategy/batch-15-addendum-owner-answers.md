# Magarine — Batch 15 addendum: the owner's answers, and the ruling on non-Latin scripts

Author: Strategist. Date: 2026-09-16. Follows `batch-15-spec.md` section 4. The owner's words are quoted as relayed by the Liaison through the Orchestrator (SOFT: I did not read the Liaison tab myself).
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 1. Typeface: IBM Plex Sans, confirmed

The default and the recommendation on record both hold. Role B ships Plex. Nothing in the spec changes.

## 2. The Next.js port carries no signal about the owner

Owner's words: "just design refrence the tool that helped me create the refrence used that stack wasn't my decision."

Ruling: `propos/fleet-and-board/` is a third-party generator's artefact. Its stack, structure, component names and file layout say nothing about what the owner wants. It may still be mined for visual ideas, as pass 3 did; it may never be cited as evidence of the owner's preference on anything. Recorded so nobody reads intent into it again.

## 3. Non-Latin scripts: Latin now, the rest designed for and deferred with a named trigger

Owner's words: "me no but future users mazbe, worth either supporting it now or add it for to do later." Timing left to us.

Ruling, adopting the Orchestrator's recommendation with the mechanism made concrete:

1. **Ship the Latin subset only in batch 15.** A wide subset costs megabytes against tens of kilobytes, is paid on every load by every user, and buys nothing for the only user who exists.
2. **The font layer is built so a later subset is one file and one block.** Batch 14 ruling 1 required one `@font-face` block per subset with its own `unicode-range` from the start. The delivered pass 3 does not have it: `tokens.css` has two `@font-face` blocks and no `unicode-range` at all (HARD, grepped the committed file). So this is **new work for Role B in batch 15**, not something to preserve: each shipped subset gets its own block with its declared range, and the element-to-field table gains a line naming the shipped ranges. Adding Arabic or CJK later is then a font file, a licence, a block, and a doctor asset line, not a redesign. IBM Plex has script-specific families (SOFT, from general knowledge of the Plex family; verify when the trigger fires).
3. **Text outside the shipped ranges is never shown silently.** This is a different failure from the font failing to load: the text will render fine, in a system font, and quietly look like the generic page the owner rejected. Under rule 9 that is not allowed. Role B adds one pure function that, given the strings the page renders from the daemon (titles, scope, conversation, inbox reasons, artefact paths), reports whether any code point falls outside the shipped ranges, with a test per range boundary. When it reports true the page shows one line, once, "some text is outside the bundled font's coverage and is shown in a system font", in the same place as the font-load notice. No per-string decoration, no colour, no interruption.

   Points 2 and 3 are two halves of one mechanism and are built together, never sequenced apart. Once a block declares a `unicode-range`, the browser uses the system font for every character outside it, which is exactly the fallback point 3 announces. The function's ranges are the same constants the `@font-face` blocks declare, read from one place, so the notice cannot disagree with the font. A test proves the two agree.
4. **Carried item, with the trigger stated.** "Ship the wide subsets when Magarine has a user who is not the owner." Added to the handover's carried list in those words. Not "later".

What this costs batch 15: one function, its tests, one notice line, one table row. What it avoids: designing the font layer twice.

## 4. Still open, still gating

Whether the owner has seen and approved pass 3 as the page they will get. Role B stays held until that yes arrives. Role A runs. Permission for the one small real run is also still open; it is needed only at Role B's close, so it does not block anything today.
