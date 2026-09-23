# Batch 19 — the owner's walk

Written by the lead, 2026-09-23, at `f7ae54d`. Batch 19's closing condition is the owner running it
on real work and saying whether it holds, the way batch 18 closed.

Nothing here is a test. Every line is a thing to try in the window, with what it should do. If any
of it is wrong, say so in the chat and it becomes the next batch's first item.

## Before you start

    git pull
    magarine doctor          # every line should say OK
    magarine app             # the window, as usual

## 1. The roster is the left column now

1. The left column lists **six profiles**, not the tickets that happen to be running: Architect,
   Developer, Reviewer, Tester, Researcher, Scribe. Each has its own shape, its model and one line
   saying what it is for.
2. A profile that is working says so, and names the ticket. The rest say idle.
3. **Rename one** (`magarine profile set --profile Scribe --name Notes`). Its shape must NOT change.
4. **Move one to another tier** (`magarine profile set --profile Notes --model claude-opus-5`). Its
   shape MUST change. A change within one tier (sonnet to sonnet) deliberately looks the same.
5. **Add one from the page**, in the roster's own form. Then retire it from its row: it takes two
   deliberate presses, and Enter twice will not do it.

## 2. The Manager assigns from the roster

6. Ask the Manager for work in the usual way. In its proposal it should now pick a PROFILE per
   ticket, with a reason, and the board should show both.
7. A ticket that got a profile runs on that profile's model, and the worker is told who it is.
8. Ask it for something a cheap profile should do (a survey, a summary) and see whether it reaches
   for Researcher or Scribe rather than sending everything to Developer. **This is the part that is
   a judgement call, not a mechanism: if it assigns badly, that is worth telling me.**

## 3. Answering several questions

9. When the Manager asks more than one thing at once, Needs You should show **one field per
   question**, not one box for all of them. Answer them and check the ticket unblocks.
10. Type into one field and wait through a refresh or two. Your text must still be there.

## 4. Steering without a terminal

11. Open the settings panel. Change **the Manager's model**, or the verifier's, for this project.
12. Change the **worker cap** and watch it take effect without restarting anything. If you started
    the daemon with `--max-parallel`, the panel should say so and tell you the flag wins until a
    restart — that is the honest case, not a bug.
13. Put something nonsensical in the cap (`3-`). It must refuse and change nothing saved.
14. **Edit the scope document in the window** and save. Then try this: open the editor, change the
    file on disk in another editor, and save. It must warn you before overwriting, not clobber.

## 5. What is deliberately NOT here

- **Seeing what a worker is running right now.** Ruled in `batch-19-item-4-drill-down.md` and not
  built yet: the command will be shown live and never stored, because a command line is the likeliest
  place for a secret and this daemon's log is permanent.
- **Creating a project from the window.** Batch 20.
- An Agent Generator that writes a profile for you. Cut deliberately; say if you want it.

## What to say back

One line is enough: does it hold on your own work, and what annoyed you. Batch 18 closed on
*"i did the run, it is fine generally"*, and that was the right amount of detail.
