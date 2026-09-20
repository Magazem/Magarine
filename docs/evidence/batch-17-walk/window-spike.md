# Batch 17 item zero: the window spike

Authority: `docs/strategy/batch-17-spec.md` section 2, ruling 30. Machine: Windows 11, Edge 153, Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`), 2560x1600 at 125 %. No product code was written or changed.

**HARD** = I ran it and read the output or the image. **NOT OBSERVED** = I could not make it happen. **SOFT** = inferred, not run.

Every window was opened with its own temp `--user-data-dir` and its own page server; I acted only on PIDs I captured at spawn (or, for leftovers, on processes carrying my unique temp-profile path); nothing was matched by process name. The spike scripts are in `spike-scripts/`.

## Result in one paragraph

Facts 1 and 3 hold. **Fact 2, the load-bearing one, holds with a hole in it**: on Edge the graceful close works (224-335 ms, five samples) **except while a Web Notification is live, when Edge ignores the close and the process outlives it for over a minute**; Chrome closes cleanly even then. **Fact 4 is partly false**: Chrome raises a real Windows toast, but **clicking it does not focus the window** — it launches a second Chrome on the owner's DEFAULT profile. The stop rule (both browsers keep the process alive) is NOT triggered: Chrome passes fact 2. But ruling 30 items 2, 6 and 7 each need a Strategist decision; see "What this changes".

## The four facts

1. **App mode opens a bare window — HARD, with a flag the ruling does not list.** With the ruling's flag set alone, Edge 153 showed an interruption: *"We are now syncing your browsing data across all your devices"* with the owner's Microsoft account email in it (this machine has a Windows-signed-in account, and a fresh `--user-data-dir` still inherits it). That capture is NOT kept (it shows the owner's email); the interstitial also made `CloseMainWindow()` return `False` and close nothing while it was up. Adding `--disable-sync --disable-features=msImplicitSignin` removes it: `fact1-edge-window.png` shows a title bar with the page favicon and title, no address bar, no tabs, nothing else. I did not isolate which of the two flags is the necessary one. Chrome needed no extra flag: `fact1-chrome-window.png` is clean.
2. **The spawned process is the browser process and exits after a graceful close — HARD, conditional.** `Start-Process` returned the browser process itself (window handle on that PID in about 0.5 s). `CloseMainWindow()`, the way a person closes it, not `Stop-Process`:
   - Edge, flags above, visible window, no notification: returned True, process exited in **331 ms, 335 ms, 224 ms**, all children gone; same with the window minimised (**319 ms**).
   - Edge with a **live notification** (`requireInteraction`): returned True, the window **stayed visible** 1.5 s later, the process was still alive after **67 s** (I then stopped it by PID); a second run showed the same at 16 s, also with the window minimised. `fact2-edge-window-survives-close-with-live-notification.png` is my window after the close, still open, no dialog. If the page closes the notification first (`n.close()`), the same close finishes in **about 1.5 s**. A plain notification (no `requireInteraction`) blocked the first close attempt while its toast was up; a second attempt after the toast had gone closed the window, and the process took 13 s to exit.
   - Chrome with a live `requireInteraction` notification: window gone within 1.5 s, process exited immediately (**one sample**), nothing left over.
   - Chrome, independent observation by the lead (not a run of mine), while cleaning up after my interrupted script: on the real spike window (Chrome app mode, title "Magarine spike window"), `(Get-Process -Id 25292).CloseMainWindow()` made the process go away in **0.34 s**. HARD, attributed to the Orchestrator's cleanup. It agrees with my own Chrome sample above.
   - NOT ESTABLISHED: why Edge behaves this way (a keep-alive held by the notification is my guess, SOFT), and whether an Edge flag turns it off.
3. **Title and favicon reach the taskbar entry — HARD.** My window gets its own taskbar entry beside the owner's pinned Edge, showing the page's favicon (`fact3-edge-taskbar-button.png`, my placeholder SVG, a red "M"), and hovering it shows the favicon and the page title (`fact3-edge-taskbar-hover.png`, "Magarine spike window"). The button's accessibility name is the app name ("Microsoft Edge - 1 running window"), not the title; the title is in the hover preview and the window's own title bar. Same on Chrome (title bar in `fact1-chrome-window.png`; taskbar button exists, hover captured for Edge only). The favicon is a placeholder I made; Role B's does not exist yet.
4. **A page notification appears as a Windows notification, and clicking it focuses the window — Chrome: appears HARD, click-to-focus FALSE HARD. Edge: NOT OBSERVED.**
   - Chrome: `fact4-chrome-toast.png` is a real Windows toast ("Google Chrome", the notification title and body, the page's favicon, the origin `127.0.0.1:<port>` under it). Windows toasts work on this machine; a control toast from PowerShell appeared in the same capture region.
   - Click: I clicked the toast body with my window minimised, and again with it open but behind another window. **Neither focused it.** The page's `onclick` never fired. Instead Windows started a **new Chrome on the owner's default profile** (command line `--notification-launch-id=0|1|Default|Chrome|0|<my origin>|…`, user-data dir `…\Google\Chrome\User Data`), showing the page in an ordinary window with an address bar (`fact4-chrome-toast-click-opens-normal-window.png`). The launch id names the profile `Default`, not my temp one, which is why (SOFT). This happened twice. I closed both instances by PID, `CloseMainWindow`, 239 ms.
   - Edge: the page reported `notification shown`, but no toast appeared in the toast region across 10 frames over 7 s, in two runs, while a control toast from PowerShell did. Cause unknown; the click was not tried on Edge (it would have started the owner's own Edge).
   - The permission grant was made over my own debug port (`Browser.grantPermissions`), **not** through the browser's permission prompt: a real click on the page button reached the page but I never captured a bubble. The overrides last only while that debug session stays connected (my first attempt closed it at once and the permission reverted to `default`, which invalidated that run; the results above are from held sessions). So "one click in the Needs You head grants it" is NOT OBSERVED.

## What this changes (for the Strategist; not decided here)

- **Ruling 30 item 6, Edge first:** on the graceful-close criterion Edge passes only while no notification is live, and it also needs `--disable-sync --disable-features=msImplicitSignin` on a machine with a signed-in Microsoft account. Chrome passes without extra flags. Chrome-first is the evidence-supported order; Edge remains the only browser guaranteed on every Windows machine.
- **Ruling 30 items 2-3 (lifecycle):** if the host waits for the process to exit, a live "Needs You" notification can keep an Edge window from closing. Mitigations I saw work: the page closes its notifications (`n.close()`) before the close, Chrome. Not tested: closing them on `visibilitychange`, or a host-side toast instead.
- **Ruling 30 item 7 (click focuses the window):** not achievable with a page-raised notification under a separate `--user-data-dir` on Chrome; the click launches the owner's default profile. Ruling 30 already holds host-side toasts as the fallback; this is the evidence for taking it.

## Residue on the owner's machine, said plainly

- Stale toasts from my tests may sit in the Windows notification centre (Chrome and Edge, pointing at a spike server that no longer exists). Clicking one would open a dead `127.0.0.1` URL in their default Chrome. I cannot clear another app's notifications.
- Two default-profile Chrome windows were opened by my toast clicks (above). Both closed gracefully; their default profile's history may contain `http://127.0.0.1:<port>/`.
- All spike processes are stopped (`Get-Process msedge,chrome` = 0 at the end), every temp profile and run directory is deleted, and the owner's `~/.magarine` was never touched.

## Not done

Edge toast click; a real permission prompt; whether one of the two Edge flags is enough; a second Chrome timing sample without a notification; taskbar hover on Chrome.
