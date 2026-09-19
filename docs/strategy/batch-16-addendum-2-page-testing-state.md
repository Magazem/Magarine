# Magarine — Batch 16 addendum 2: the page is tested by running it, in two harnesses that each say what they prove

Author: Strategist. Date: 2026-09-19. Raised by the Designer, who stopped before spending the time; brought by the Orchestrator because it changes the testing state. Every fact below checked this turn.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. The facts

- HARD: `packages/core/package.json` has no dependencies; every `src/ui/*.test.ts` asserts on source text. Nothing in the suite executes `ui/app.js`. Batch 16's two Role B acceptances ask for behaviour, so as written they ask for run-proof from a suite that has never run the page. That is the addendum 6 gap restated, and it is mine: I wrote acceptances the testing state could not honour.
- HARD: the Designer has drafted `src/ui/domHarness.ts`, 344 lines, untracked: a hand-rolled DOM in a `node:vm` context running the real `app.js`, `organism.js` and `fontCoverage.js`, discovering elements from the real `index.html`, throwing on anything unimplemented, with a stub `fetch` answering from hand-written fixtures.
- HARD: batch 15's real-browser work exists and is gitignored: `.shots/shoot-cdp.cjs`, `motionproof.cjs`, `tabwalk.cjs`, `keyscroll.cjs`, `stub-daemon.cjs` and four more, driving system Chrome over the DevTools protocol. Ruling 18 requirement 4 and the keyboard reach were proven by those scripts and by nothing in the suite.
- HARD: Node 26.2.0 has a built-in `WebSocket` client and `fetch`; it has no `EventSource`. Chrome is at `C:\Program Files\Google\Chrome\Application\chrome.exe`. Tests already spawn a real daemon (`daemon.test.ts`, `daemonApi.test.ts`).
- HARD, from the batch 15 evidence README: the `.shots` stub daemon sent `latest_activity` where the daemon sends `latestActivity`, and eleven screenshots agreed with the page because the stub was authored from the page.

## 1. Ruling 26

**Yes to running the page, in two harnesses, each with a stated claim it may make and a condition that keeps it from agreeing with itself. No hand-written daemon fixtures anywhere.**

### The DOM harness: accepted, with three conditions

1. **Elements come from the real `index.html`** (the Designer's guard 1). A dropped or renamed id fails the test that needed it.
2. **It throws on anything it does not implement** (guard 2). A shim that answers a plausible value is a fixture agreeing with itself. This is also what makes its maintenance visible: the harness grows only when the page grows, and a throw names what.
3. **The daemon is real.** The stub `fetch` and its fixtures are removed. The harness's `fetch` is Node's own, pointed at a daemon spawned in the test with the fake adapter, the same way `daemonApi.test.ts` already does. The daemon is the fixture. This is not a mitigation of the stub-daemon class; it is its removal. Item 1's test then creates a project through `POST /projects`'s real route while the page is loaded and asserts the selector; item 2's test pauses a real project through ruling 24's real path once Role A item 5 lands, and until then asserts against the shape the ruling states, marked as such in the test name.

**What it may claim:** the script's state-to-DOM behaviour under real daemon responses. **What it may not claim, written in its header and in the testing-state section of the handover:** rendering, layout, focus, motion, contrast, and the live stream. Node has no `EventSource`, so under this harness the page takes its own "stream unavailable, polling" branch, which is a real branch and is exercised honestly; the stream path is the browser harness's.

### The browser harness: promoted from `.shots` to the suite

4. **`src/ui/browser.test.ts`**, zero dependencies: spawn Chrome headless with a remote debugging port, connect with Node's `WebSocket`, drive `Page.navigate` and `Runtime.evaluate`, against the same spawned real daemon. Chrome is resolved like `claude` is (`process.ts`'s `resolveCommand`), overridable by `MAGARINE_CHROME`. The `.shots` scripts are the source; what moves is the client and the two proofs that need a browser now: ruling 18 requirement 4, motion surviving a re-render under a scripted burst from Role A item 1, and `aria-current` drawn on the current view. The keyboard walk moves when it is next needed, not now.
5. **When Chrome is absent the file reports one named skip with the reason**, and `node --test`'s summary shows the skipped count. Rule 20 closes the gap that a skip could open: **every batch's `RESULT.md` quotes the suite summary line and states that the browser tests ran on the walk machine, with the count.** A green suite with the browser file skipped is not the closing condition.

**What it may claim:** what the real browser did on one machine, on one run. Nothing more, and nothing less, which is more than anything else in the suite can say about the page.

## 2. Why not the cheaper alternative

Source-text assertions for items 1 and 2, with the acceptances recorded as "not proven by run", is the choice that let `latestActivity` and `aria-current` through. This batch exists to stop that. The maintenance cost is real and accepted; condition 2 makes it visible instead of silent, and condition 3 removes the failure mode that actually cost eleven screenshots.

## 3. Sequence and ownership

Role B, in order: strip the fixtures from the harness and point it at a spawned daemon; land items 1 and 2 on it; then the browser file with the two proofs, after Role A item 1 lands the burst. Each its own task and commit. The Orchestrator runs the browser file on this machine as part of every verification from now on and quotes the summary line.

The spec's Role B acceptances are amended by this addendum: "a page test" means a DOM-harness test against a spawned daemon; anything about rendering or motion means a browser test.
