# Magarine

Magarine takes a project scope you write -- the same way you'd hand one to a
person -- and works the project from it: it reads the scope, asks you
whatever it's missing before it assumes anything, plans what it already
understands into ordered tasks, then runs an AI coding assistant on several
of them at once wherever they don't depend on each other, holding the rest
back until whatever they need is actually finished, and tracks what every
task cost. You can keep talking to it as it goes -- answer its questions,
tell it to change course, ask it to propose the next batch -- and it folds
each reply back into the same scope document and the same plan, rather than
starting over. You can drive all of this from a terminal with a handful of
plain commands, or from a small browser page that shows the same board,
inbox, and conversation this file describes, refreshed live. This one page
is everything you need in order to use it today.

## Install (four commands)

Open a terminal in the folder where this project's code lives, then run:

```sh
cd packages/core
pnpm install
npm install -g .
magarine doctor
```

The last command checks your machine is ready (Node.js version, whether the
`claude` tool is installed and logged in, and so on) and prints one line per
check: `PASS`, `FAIL` (with what to do about it), or `SKIP` (a check that
genuinely couldn't be answered -- not itself a problem). Fix anything marked
`FAIL` before continuing -- it is meant to catch problems here instead of
partway through a real run.

**If `magarine` isn't found after that:** close your terminal and open a new
one (installing it can update settings your current terminal already loaded
before you ran the command), then try `magarine doctor` again. If you'd
rather use `pnpm link --global` instead of the third command above, it needs
a one-time `pnpm setup` first, and *also* needs a brand new terminal
afterward -- `npm install -g .` avoids that extra step, which is why it's
the one above.

## Your first project (worked example)

This is the actual use case Magarine is built for, in the words it was
described in: *"I would give it an md file with a project scope, something
similar to how we started this whole project, and work on it with it."*
Here is exactly that, end to end.

Run these from wherever `magarine` is on your PATH:

1. **Make a folder for the project, and stand inside it.** This folder
   becomes the project's one home: its scope document lives here, and so
   does anything a task writes when it needs a shared workspace. It is also
   the boundary a task's own AI assistant may write inside -- never anything
   outside it -- so it must be a folder made for this, not a folder you
   already keep other things in. If you already have a scope document
   written, save it here now as `SCOPE.md` -- Magarine will pick it up
   automatically once the project exists. If you don't, that's fine too; the
   interview (step 4) builds one with you. Either way, `project create` (next
   step) tells you when it did not find a `SCOPE.md`, so you are never left
   guessing what the Manager will read.
   ```sh
   mkdir my-first-project && cd my-first-project
   ```

2. **Create the project**, from inside that folder:
   ```sh
   magarine project create --name "My First Project" --brief "One paragraph describing what you want built."
   ```
   Without `--max-parallel`, the project has no cap of its own -- how many
   tasks run at once is decided by the daemon's number (step 3). Give it
   `--max-parallel <n>` only if you want THIS project held below that; change
   it later with `magarine project set --project <projectId> --max-parallel
   <n>`, or `--max-parallel none` to go back to no cap of its own.

   This prints the project's id (starts with `proj_`) -- you'll use it in
   every command below. **Lost it, or closed the terminal?** Every command
   below also accepts the project's exact name instead of its id, and
   `magarine project list` shows every project you have, with its id, name,
   cost, and how many tasks are in each status -- run that any time you need
   to find your way back. (Standing somewhere else on purpose? `--dir <path>`
   names a different folder instead of the one you're in; `project set --dir
   <path>` moves it later.)

3. **Open the window.** This starts the background process that actually
   reads your scope, talks back to you, and runs your tasks, using the real
   `claude` tool -- and opens the board in a window of its own. Every task is
   a real run with an equivalent API cost -- typically cents for a single
   reply or a small task, shown on the board as it happens. Leave this
   terminal open -- it prints the port the daemon is listening on and the
   page's address, and keeps running until you stop it. Do step 2 first: the
   window shows the projects that already exist, and cannot create one yet.
   ```sh
   magarine app --adapter claude --max-parallel 4
   ```
   The window is Chrome's (or Edge's, if there is no Chrome; `magarine doctor`
   names which, or says none was found). **Closing the window does not stop
   the daemon or the work** -- the terminal says so, and `magarine app` opens
   the window again; `Ctrl+C` in the terminal is what stops it. If you would
   rather use a plain browser tab, `magarine serve --adapter claude
   --max-parallel 4` runs the same daemon with no window.

   This is the one number that decides how many tasks run at once: the most
   workers the daemon runs at once across every project (a project only runs
   fewer if you gave it a smaller cap of its own in step 2). The line it
   prints says "up to 4 workers at once" so you can see the number you're
   running under; leave the flag off and it is 1. Each worker is a real
   session against your subscription's limits, so the number is your choice:
   start lower if you'd rather it spend more slowly.

4. **Let it interview you.** Write `SCOPE.md` in the project's folder BEFORE
   you run `plan` if you have a scope to hand over -- or run `plan` without
   one and answer the interview in Needs You; both are fine, and `plan` says
   `scope document: <path> (not found; ...)` when it is starting from nothing.
   If you already saved a `SCOPE.md` in the project's folder (step 1), just
   plan from it directly:
   ```sh
   magarine plan --project <projectId>
   ```
   If you didn't, write what you want as your `--mission` instead -- a short
   sentence works, or a whole document (`--mission "$(cat my-notes.md)"`); it
   is saved as the project's `SCOPE.md` before planning:
   ```sh
   magarine plan --project <projectId> --mission "Describe what you want built."
   ```
   **On a fresh project, expect it to come back with only questions and no
   tasks at all -- that is the intended first reply, not a stall.** It would
   rather ask what platform you're targeting, what's out of scope, or what
   "done" looks like than guess and build the wrong thing. Only once it says
   it has enough does it propose an actual batch of tasks.
   ```sh
   magarine inbox --project <projectId>
   ```
   shows its questions, in full, and tells you the exact command to answer
   each one.

5. **Talk to it.** Answer its questions, steer it, or tell it to go ahead --
   all through the same command:
   ```sh
   magarine discuss --project <projectId> --message "Target iOS only for now. Go ahead and propose the first batch."
   ```
   Each message is one more run with its own equivalent API cost: it reads
   your scope document and the board fresh, replies, and updates the scope
   or proposes tasks as needed. Once the scope already has content, running
   `plan --mission` again refuses (it won't silently overwrite what you and
   it have built together) -- edit `SCOPE.md` directly, or keep using
   `discuss` to add to the conversation.

6. **Watch it work.** The window from step 3 shows the board, inbox, and the
   whole conversation in one place, refreshing live, already signed in. (In a
   plain browser tab -- `magarine serve`, or a window that did not open --
   run `magarine token` in another terminal: it copies the token to your
   clipboard, and you paste it into the page and pick your project.) Or, from
   a second terminal:
   ```sh
   magarine board --project <projectId>
   magarine inbox --project <projectId>
   ```
   Run these again any time to see current status -- they don't refresh on
   their own.

7. **Add a task yourself, any time.** The Manager normally proposes the
   tasks, but you can also add one by hand:
   ```sh
   magarine ticket add --project <projectId> --title "Write hello.py that prints hello" --workspace DIRECTORY --expected-artifact hello.py
   ```
   `--workspace DIRECTORY` makes the task work in your project's folder (so
   `hello.py` lands next to your `SCOPE.md`); `--workspace NONE` gives it a
   throwaway folder instead. The flag is `--workspace` -- there is no
   `--kind` -- and `magarine ticket add --help` lists every flag it takes.
   `magarine board --project <projectId>` shows the new task; with `magarine
   serve` running, it is picked up on the daemon's next pass.

8. **Respond when it needs you, then stop.** If `inbox` shows something, see
   "The inbox" below for what to do -- and `discuss` any time you want to
   change direction, correct something, or ask it to plan the next batch.
   When you're satisfied, go back to the terminal running `magarine app`
   (or `serve`) and press `Ctrl+C` to stop it. Any task running at that
   moment is cancelled, goes back to READY, and starts over from scratch the
   next time you start it -- so what it had already spent is spent again; if
   any were running, it prints one line naming them, and prints nothing when
   nothing was running.

## The board

`magarine board --project <projectId>` lists every task in the project: its
id, status, title, how many attempts it's used, and its equivalent API cost
so far. Status is one of:

- **OPEN** -- waiting on another task it depends on.
- **READY** -- next in line to run.
- **IN_PROGRESS** -- running right now.
- **REVIEW** -- finished; waiting for you to approve or reject it.
- **BLOCKED** -- stopped to ask you a question.
- **DONE** -- finished and accepted.
- **FAILED** -- did not succeed after every attempt it was allowed. See
  "When something says FAILED" below.
- **CANCELLED** -- you stopped it yourself.

The project's total equivalent API cost, against any spending limit you
set, is on the first line -- unless the project is paused, in which case the
very first line instead reads `PAUSED: <reason>`, and names the exact
command that clears it. **"Equivalent API cost" is what the tool would have
billed at metered rates, for comparison -- if you're testing on a
subscription rather than metered billing, this is not money leaving your
account, and the real constraint is session limits, not dollars.** A task
still showing READY while paused is not about to run; nothing starts again
until the pause is addressed.

Rows marked `[MANAGER]` are the interview/planning turns themselves --
`plan` and `discuss` each create one. They cost and behave like any other
task (attempts, retries, a budget ceiling); they just don't produce files,
only a reply, a scope update, or a proposal.

## The inbox

`magarine inbox --project <projectId>` lists only what's waiting on **you**,
in full -- never truncated, so you always see the whole reason. Each line
tells you what to do next:

- A task **asked a question**: answer it with
  `magarine decide --ticket <ticketId> --answer "your answer"`.
- A task is **waiting for review**: read its result, then
  `magarine approve --ticket <ticketId>` or
  `magarine reject --ticket <ticketId> --reason "why"`.
- A task **failed for good**: `magarine retry --ticket <ticketId>` to give it
  another attempt, once you've addressed whatever the reason line says.
- The **project is paused**, for one of two reasons, and the inbox line
  names the exact fix:
  - **Spending limit reached**: raise it with
    `magarine project set --project <projectId> --max-spend <amount>` --
    this clears the pause by itself, no separate `resume` needed.
  - **`claude` isn't usable right now** (not logged in, or couldn't be
    started): run `claude` once to log in, then
    `magarine resume --project <projectId>`.

An item disappears from the inbox on its own once you've acted on it -- there
is nothing separate to dismiss.

## The conversation

`magarine discuss --project <projectId> --message "<text>"` is how you talk
to it once it's running: answer a question outside the inbox flow, correct
something, or tell it to go ahead and propose. The same conversation --
your messages, its replies and assessments, its questions, and every scope
update -- is also what the page's conversation panel shows, oldest first,
in full, with a box to answer a live question right there instead of
switching to `decide`. The scope document itself is shown next to it,
read-only, so you can always see exactly what it's currently working from;
edit the file directly any time, or let `discuss` update it for you.

## When something says FAILED

Run `magarine doctor` first -- it catches the most common causes (Node too
old, `claude` missing or not logged in, the daemon not running when a command
needs it) with a plain sentence telling you what to do. If `doctor` is all
`PASS`, check `magarine inbox --project <projectId>`: a failed task's reason
is shown there in full, and it is almost always either something in the
task's own instructions or a spending limit that needs raising
(`magarine project set --project <projectId> --max-spend <amount>`).

**If a task never even starts running** (it sits IN_PROGRESS with no
progress, or fails immediately with an unfamiliar error), run
`magarine doctor` and look at its `claude CLI` line specifically -- it
names both the exact path `claude` was found at and how it was found
(a plain PATH entry, or one of two different ways of unwrapping a Windows
`.cmd` shim). If you're asking someone else for help, send them that one
line: it is usually enough on its own to tell a wrong-installation problem
apart from a login problem or a genuine bug.

## Where things live

- **Your project's own folder**: the one you stood in when you ran
  `project create` (or named with `--dir`). This is the project's one home:
  `SCOPE.md` lives here, edit it by hand any time and the next `plan` or
  `discuss` reads whatever is currently on disk, and any task you give a
  shared workspace with `--workspace DIRECTORY` writes here too. `project
  set --project <projectId> --dir <path>` moves it later.
- **State** (your projects, tasks, and their history): a small database file
  under `~/.magarine/` by default. Set `MAGARINE_HOME` or pass
  `--state-dir <folder>` to any command to use a different location. This
  is Magarine's own bookkeeping, separate from any project's own folder
  above.
- **Equivalent API cost**: shown per task on the board, and as a running
  total for the whole project on the board's first line -- what the tool
  would have billed at metered rates; on a subscription, not money leaving
  your account, and the real constraint is session limits, not dollars.
- **Worker output**: under `~/.magarine/artifacts/` for a task with no
  shared workspace (the default), or in the project's own folder above for
  one given `--workspace DIRECTORY`.

Nothing is written outside your project's own folder or `~/.magarine/`
unless you explicitly asked for it (`--state-dir`, or `--workspace` naming
somewhere else).
