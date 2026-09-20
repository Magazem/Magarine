# Product requirement: an end user runs the app, not a terminal

Stated by the owner, 2026-09-20, in their own words:

> *"will the end user still need to run the command line like us forcefully not optionally? i
> prefer if they just run the app and it works, unless they want special types of launching,
> this is anyway for late stage not now, now we are still in beta and it is fine but worth
> recording that"*

**Trigger: LATE STAGE, explicitly not now.** The owner said beta is fine as it is. This file
exists so the requirement is not lost, not so it is acted on. Do not schedule it against this
record alone.

## The requirement

1. **An end user launches the app and it works.** No terminal, not even once.
2. **The command line stays** — for "special types of launching", i.e. the deliberate,
   power-user route. It becomes OPTIONAL, not removed.

Two audiences, then: the owner and us, who will keep using the CLI; and an end user who should
never have to meet it.

## Where the product actually stands today (HARD, verified 2026-09-20)

The CLI is **mandatory**, not optional. Everything an end user needs goes through it:

- `magarine serve` must be started from a terminal, and that terminal must stay open — the
  daemon is that process. The page the owner uses is served BY it.
- `magarine project create` is the only way a project comes into existence.
- `magarine project set --dir`, `magarine resume`, `magarine decide`, `magarine token` are the
  named fixes the product itself prints when something needs a human.

So the page is a window onto a daemon that only a terminal can start, and several of its own
error messages instruct the reader to go back to the terminal. That is the gap.

## What closing it would actually take — scoping only, NOT a plan

- **Launching the daemon without a terminal**, and supervising it: started on app open, still
  alive, restarted or reported when it dies. The daemon's lifetime currently equals a console
  process's lifetime.
- **Project creation in the interface**, since `project create` is today the only door in.
- **The product's own instructions changing audience.** Every message that names a CLI command
  as the fix — the readiness pauses, `resume`, `decide`, `token` — either needs an in-app
  equivalent or must be shown only to someone who has a terminal. A page that says "run
  `magarine project set --dir`" to a user with no terminal is rule 9's silent-fallback problem
  wearing different clothes: technically true, useless to the reader.
- **Packaging and install**, so "run the app" means something on a machine that has never seen
  Node or `pnpm`.
- **`claude` must still be present and logged in.** That is an external dependency the app
  cannot remove, only detect and explain. `doctor` already does the detection.

## Relationship to batch 17

Batch 17 is the **Windows window host** — the board in its own desktop window rather than a
browser tab. That is the first step of this requirement and NOT the whole of it: a window that
still needs a terminal to start the daemon has changed where the board is drawn, not who can
use the product.

Worth deciding when 17 is specified: whether the window host should launch and supervise the
daemon itself. That single decision is most of the gap above, and doing it in 17 is far cheaper
than retrofitting it later. **That is a question for the Strategist at spec time, not a
decision recorded here.**
