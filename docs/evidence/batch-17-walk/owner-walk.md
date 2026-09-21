# Batch 17 closing condition, part 4: the owner's walk

2026-09-21. The owner ran Magarine on a real project of their own, not a demo. Their report,
verbatim, followed by the lead's triage. **The verbatim text is the evidence; the triage is
only a reading of it.**

## Verbatim

> all worked well generally, Ctrl+C worked, manager is a fine name. i think it can be available
> and one can modify it in real time.
> the scope hight panel is bothering, nether the scope is easily readable and neither the chat.
> Bugs:
> 1- when needs you, if you click the text box in two seconds it makes like a refresh animation
> and it stops the input, so it is really hard to read, even in scope it does that sometimes but
> noticed it less frequent, all models are just the default, i started a project and everyone is
> sonnet, also they have no character, not one dev one is designer one is blah blah, and they are
> all sonnet 5 it seems by default, i Don't know who the manager at this point it doesn't seem like
> it has a seperate exestince it feels like jsut a buncg of sonnets working and that is it and they
> do all the work by themselves like i Don't know if they communicate or if it possible to ask the
> manager to lauch another worker just to do research on this topic rather they will just sprint
> through the task, there is no way to know what is happening in real time, i only see that one
> worker is running PowerShell, what is it running exactly, is it stuck i have no idea what is
> hapening what so ever i am fine with that as a default behaviour but i should be able to dig, as
> said, also that one can't configure much from the within the app, can't change max parallel,
> have to stop the whole thing and relaunch it with a higher parallel limit.
> also design suggestion, i wanted originally that when the manager send me a bunch of question
> at once for me to have a field for each question, for that our app understand that this was a
> question and give it it's field i think this design is better so one can answer each question
> independently,
> some text is outside the bundled font's coverage and is shown in a system font
> outside the bundled subsets: U+2192 U+2713
> it worked it worked and then it just stopped, i tried talking to the manager but didn't respond
> afterwards twice, i wanted a follow up nothin is working anymore.
> and the work is basically a lotof placeholders and whatnot, no real work was done, it only did
> phase 0 and not fully done according to a review session done by another real working harness
> and it found : Defects: 0 Critical, 3 High, 4 Medium, 7 Low
> thus at least if it is gonna run autonomsly it should have checked after itself that everything
> worked, the whole workflow doesn't seem correct at all but maybe it is by design because it
> wasn't built yet, then i would understand

## Batch 17's own closing items -- PASSED

- **Real Ctrl+C: OBSERVED by the owner, worked.** This closes the last NOT OBSERVED in batch 17;
  until now the daemon-then-window ordering rested on a simulated `process.emit('SIGINT')`.
- **"Manager" is the right word.** Confirmed.
- **The scope panel's height: it bothers them.** Neither the scope nor the chat is easily
  readable. Owner taste, now answered -- a layout change is wanted.

## Lead's triage -- for the Strategist to rule on, not decided here

**A. Defects blocking use**
1. **Typing is destroyed every ~2 seconds** in the Needs You answer box (and sometimes on the
   Manager tab): a refresh re-renders and the input is lost. The page polls every 4s
   (`POLL_MS` in app.js). This one makes the product close to unusable for its core loop.
2. **The Manager stopped responding** mid-project; two follow-ups got no reply.
3. **Two glyphs outside the bundled font:** U+2192 (right arrow) and U+2713 (check mark).

**B. The finding that matters most: the work was not real.** Placeholders, only phase 0 and not
finished; an independent review by another harness found 0 Critical, 3 High, 4 Medium, 7 Low.
In the owner's words, *"if it is gonna run autonomsly it should have checked after itself that
everything worked."* Batch 15's expected-artefacts check proves a FILE exists; nothing checks
that the work in it is real, complete, or correct.

**C. The owner cannot see or steer what is happening**
- No real-time visibility: "one worker is running PowerShell, what is it running exactly, is it
  stuck" -- they are fine with a quiet default but must be able to dig in.
- `max-parallel` cannot be changed from the app; the whole thing must be restarted.
- The scope cannot be edited in real time from the app.

**D. The Manager and the workers have no identity or structure the owner can perceive**
- Every worker is sonnet by default; no roles ("one dev, one designer").
- The Manager does not feel like a separate existence -- "just a bunch of sonnets".
- Unclear whether workers communicate, or whether the Manager can be asked to launch a
  research worker instead of sprinting through the task.
- Worker profiles were planned for batch 16 and deferred; they have not been built.

**E. A design the owner originally wanted:** when the Manager asks several questions at once,
one answer field per question, so each can be answered independently.

The owner's last sentence is a fair question and deserves a straight answer, not a defensive
one: *"maybe it is by design because it wasn't built yet, then i would understand."* Some of this
was never built. Some of it was built and does not work well enough. The Strategist's ruling
should say which is which.
