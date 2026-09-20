# Magarine — Batch 17 addendum 1: ruling 30 amended by the window spike

Author: Strategist. Date: 2026-09-20. Amends `batch-17-spec.md` section 1 (ruling 30) and section 4 (the walk). Evidence: `docs/evidence/batch-17-walk/window-spike.md` at `15fe64c`, of which I read the text, the two load-bearing captures (`fact2-edge-window-survives-close-with-live-notification.png`, `fact4-chrome-toast-click-opens-normal-window.png`), and `spike-scripts/testN.ps1` and `server.mjs` to see how the close-with-notification run was made. The one capture I could not read is the Edge sync interstitial, discarded because it carried the owner's account email; that finding rests on the engineer's word and the Orchestrator's reading, and I accept it.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. The result in one paragraph

The stop rule is not triggered: application mode is a bare window and the process exits on a graceful close (HARD, both browsers). Three things ruling 30 promised are wrong or unproven, and one decision fixes two of them. **Notifications move from the page to the host.** With no Web Notification ever raised in the window, the Edge close-that-never-completes is never entered, and the Chrome toast click that opens the owner's default profile cannot happen. The remaining change is the browser order and two Edge flags. Items 4 and 7 may be dispatched; what each may promise is in section 4.

## 1. Item 6 amended: Chrome first, Edge second, the override still wins

Ruling 30 item 6 said Edge first because it is on every Windows machine. The spike says (HARD):

- Chrome opened a clean window with the ruling's flags and nothing else, and closed gracefully in every sample (two people, three samples, 0.34 s to 1.5 s).
- Edge, with the ruling's flags alone, showed a sync interstitial carrying the owner's Microsoft account email, because a fresh profile directory still inherits the Windows-signed-in account; and while that interstitial was up, the graceful close did nothing. `--disable-sync --disable-features=msImplicitSignin` removes it.

**Amended item 6:** `--browser` or `MAGARINE_BROWSER`, then Chrome, then Edge. Edge is always launched with both extra flags; nobody spends a session isolating which one is necessary, because both are harmless and the pair is proven. The reason is not only the interstitial: a window profile implicitly signed in to the owner's account with sync on would carry our page's address into their account's history (SOFT), and the whole point of the separate profile was that nothing of ours touches theirs. The no-browser fallback in item 6 is unchanged. **OWNER TASTE, restated:** on this machine the window is a Chrome window; on a machine without Chrome it is an Edge one. Fallback shipped: this. The order is one array in `commands/app.ts`, so the owner's overrule is one line.

`doctor`'s `window host` line (Role A item 5) names whichever it resolved, and says `edge, with sign-in and sync disabled` when it is Edge, so the flags are visible without reading code.

## 2. Items 2, 3 and 5: the lifecycle stands, with three hardenings

The worst input to "the host lives until the child exits" was a live Web Notification on Edge: `CloseMainWindow()` returned True, the window stayed open, the process outlived the close by over a minute (HARD, two runs, capture read). That input no longer exists, because section 3 forbids the page from raising Web Notifications. Items 2 and 3 therefore stand as written: owned mode's lifetime is the daemon's, attach mode's is the window's, the host waits on the child process's exit and on nothing else. **No window-list polling, no exit timeout on the window.** A window that will not close is visible to the owner and they close it again; a host that guesses is worse.

Three hardenings, so the promise survives the things the spike could not cover:

1. **Ctrl+C in owned mode closes the window gracefully first.** Node's `child.kill()` is a termination, not a close. The host asks the window to close the way a person does, through the same PowerShell seam section 3 uses for toasts (`(Get-Process -Id <pid>).CloseMainWindow()`), waits up to five seconds for the child's exit, and only then kills it. Chromium persists window bounds on a graceful close; item 5's "the owner's last size and position come back for free" is SOFT and depends on this. The seam is injected, so the test proves the order (close asked, wait, kill only on timeout) without a browser.
2. **`--hide-crash-restore-bubble` joins item 5's flag list** (SOFT: a Chromium window whose last exit was a kill offers to restore on the next launch; this flag suppresses it). The walk's step 5 verifies: the window returns with no bubble.
3. **The page never registers `beforeunload`, and never raises a `Notification`.** Both are the known ways a page stalls a graceful close. `ui/app.js` has neither today (HARD, grep, no match). The rule goes into the element-field table's header comment so the next Designer sees it.

SOFT, for the record: the Chrome spike runs were made with the owner's own Chrome not running (inferred from the toast click launching a new default-profile instance rather than reusing one). Chromium treats a distinct `--user-data-dir` as a distinct instance whichever browser it is; the spike proved that on Edge with the owner's Edge running (HARD, the spec's own finding). Nothing in the walk changes for it.

## 3. Item 7 amended: Needs You is a host-side toast, and the page raises nothing

The spike says (HARD): a Chrome toast raised from our window is a real Windows toast, but clicking it does not focus our window and never reaches the page's `onclick`; Windows starts a new Chrome on the owner's DEFAULT profile with our address in an ordinary tab (capture read: address bar, tab strip, `127.0.0.1:<port>`). Edge raised no toast at all. The permission prompt the ruling relied on was never seen; the grant was made over a debug port. So item 7 as written promises two things it cannot do (click focuses the window, one click grants it) and one thing that is actively harmful (a toast that opens our page in the owner's own browser, outside the launch-code flow, on a profile whose history they keep).

**Amended item 7.** The host raises the notification, not the page.

- The host consumes `GET /events` with the bearer token from `daemon.json` through `daemonClient.ts`'s existing `consumeEventStream` (HARD, line 119; sends `Authorization: Bearer`, never a URL), in both owned and attach mode, one code path. It filters `worker_needs_user_decision` and `worker_needs_review`.
- On each such event it raises one Windows toast through PowerShell's `Windows.UI.Notifications` (the spike's control toasts prove the mechanism on this machine, HARD). Title `Magarine needs you`; body the ticket's title and the inbox item's one-line message. **No launch action**: clicking it dismisses it and nothing else. The sender line reads "Windows PowerShell"; ruling 30 already accepted that as the fallback, and it is now the path.
- The ticket title and message are owner text and go to PowerShell **on stdin, never as a command-line argument**, exactly the discipline `token.ts` enforces for the clipboard tool (HARD, its header comment and injected `runTool` seam). The test proves it the same way.
- How the owner reaches the window: the taskbar entry, whose title already carries the count (`(2) Magarine`, Role B item 1, committed at `07ade24`, HARD by the log; I have not re-read the page). That is the honest promise: the OS tells them, the taskbar tells them where.
- `--no-notify` turns it off. Default on, no permission, no page control. **OWNER TASTE, restated:** notifications are on by default, sent by "Windows PowerShell", and do not open the window. Fallback shipped: this. A real sender name needs a registered application identity, which is the installer's job in the late-stage batch, not this one.
- Not Windows: no toast, and `app --help` says notifications are Windows-only in the same sentence that says the window is tested on Windows only (item 9).
- No coalescing this batch: one event, one toast. If the walk finds it noisy, that is a one-line finding.

**Role B item 3 is cut to nothing.** No `Notification` code, no panel-head control, no permission state. Its one surviving obligation, the `beforeunload`/`Notification` prohibition, is a comment. Role B item 4 (the browser proof of the launch code) stands unchanged. The work moves to Role A as a new item 4b, below.

Residue from the spike that the owner must be told at the walk offer, through the Liaison, in one sentence: stale spike toasts may sit in their notification centre and would open a dead `127.0.0.1` address in their own Chrome if clicked; dismissing them is all that is needed. Nothing is running and no profile of theirs was written.

## 4. What items 4 and 7 may promise, for the briefs

**Role A item 4, `magarine app`, may promise:** owned and attach mode as ruled; Chrome then Edge with the flags of sections 1 and 2; the host waits on the child's exit and nothing else; Ctrl+C in owned mode stops the daemon, asks the window to close, waits five seconds, kills; the token in no spawn argument, no stdout, no stderr; the no-browser line. **It may not promise** window bounds persistence (SOFT, unverified until the walk) or anything on macOS or Linux.

**Role A item 4b, Needs You as a host toast, may promise:** within a few seconds of a `worker_needs_user_decision` or `worker_needs_review` event, a Windows toast with the ticket title and message, in both modes, off with `--no-notify`; title and message never on a command line. **It may not promise** that clicking the toast focuses or opens anything, a sender name other than "Windows PowerShell", or anything off Windows. Acceptance: with a fake stream and the injected seam, one toast per qualifying event and none for others; the stdin-not-argument proof; `--no-notify` raises none; a stream that ends (daemon gone) ends the consumer without the host crashing, and in attach mode the host still exits when the window does.

Sequence for Role A: item 3 (launch codes, unchanged), item 4, item 4b, item 5. The Orchestrator verifies each on a still tree as before; the tree is not still now (HARD, `git status` this turn: `daemon.test.ts` modified, `serveShutdown.test.ts` untracked, item 1 in flight), and the amendment is committed beside that work, not on top of it.

## 5. Section 4, the walk, amended

Step 3 becomes: in another terminal, `ticket add` a task scripted `--fake-script <id>=needs_user_decision`, then a `tick`; the window title reads `(1) Magarine`; a Windows toast appears with the ticket's title; capture of the toast; clicking the toast dismisses it and opens nothing; clicking the taskbar entry brings the window forward. Steps 5 adds: the window returns with no restore bubble. Step 7 adds: a Needs You ticket ticked under attach mode raises the toast from the `app` terminal's host, not from `serve`. Everything else in section 4 stands.

## 6. What I would still cut, if session limits bite before item 4b

Item 4b is the last of the four to ship and the first to drop. A beta with the count in the window title and no toast is a usable beta; the owner said the goal is one they can run their real work through, and the taskbar title already says when it needs them. The order in section 4 puts 4b after item 4 for exactly that reason.
