# Magarine

Magarine takes a project scope you write -- the same way you'd hand one to a
person -- and turns it into working output: it plans your scope into ordered
tasks, then runs an AI coding assistant on several of them at once wherever
they don't depend on each other, holding the rest back until whatever they
need is actually finished, and tracks what every task cost. Right now you
drive it from a terminal with a handful of plain commands; there is no other
interface yet (a browser page showing the same board and inbox this file
describes is coming), and this one page is everything you need in order to
use it today. While it works, you watch it through a live board and an
inbox that tells you exactly what, if anything, needs your decision.

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

## Your first project and mission (five steps)

Run these from anywhere, once `magarine` is on your PATH:

1. **Create a project.** This is a named container for the work.
   ```sh
   magarine project create --name "My First Project" --brief "One paragraph describing what you want built."
   ```
   This prints the project's id (starts with `proj_`) -- you'll use it in
   every command below.

2. **Give it a mission.** Write what you want in a plain markdown file -- a
   project scope, the same way you'd write one for a person -- then hand it
   over. (A short sentence works too; the file is just the natural way to
   write a real scope.)
   ```sh
   magarine plan --project <projectId> --mission "$(cat my-project-scope.md)"
   ```
   Magarine reads that and plans it into an ordered set of tasks. This step
   only plans -- it doesn't run anything yet.

3. **Start the daemon.** This is the background process that actually runs
   your tasks, using the real `claude` tool -- this is the step that spends
   money (typically cents, not dollars, for a small mission; each task's
   cost shows up on the board). Leave this terminal open -- it prints the
   port it's listening on and keeps running until you stop it.
   ```sh
   magarine serve --adapter claude
   ```

4. **Watch it work, from a second terminal.**
   ```sh
   magarine board --project <projectId>
   magarine inbox --project <projectId>
   ```
   Run these again any time to see current status -- they don't refresh on
   their own.

5. **Respond when it needs you, then stop.** If `inbox` shows something,
   see "The inbox" below for what to do. When you're satisfied, go back to
   the terminal running `magarine serve` and press `Ctrl+C` to stop it
   cleanly.

## The board

`magarine board --project <projectId>` lists every task in the project: its
id, status, title, how many attempts it's used, and what it has cost so far.
Status is one of:

- **OPEN** -- waiting on another task it depends on.
- **READY** -- next in line to run.
- **IN_PROGRESS** -- running right now.
- **REVIEW** -- finished; waiting for you to approve or reject it.
- **BLOCKED** -- stopped to ask you a question.
- **DONE** -- finished and accepted.
- **FAILED** -- did not succeed after every attempt it was allowed. See
  "When something says FAILED" below.
- **CANCELLED** -- you stopped it yourself.

The total spend for the project, against any spending limit you set, is on
the first line.

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
- The **project is paused** (usually a spending limit): fix the cause, then
  `magarine resume --project <projectId>`.

An item disappears from the inbox on its own once you've acted on it -- there
is nothing separate to dismiss.

## When something says FAILED

Run `magarine doctor` first -- it catches the most common causes (Node too
old, `claude` missing or not logged in, the daemon not running when a command
needs it) with a plain sentence telling you what to do. If `doctor` is all
`PASS`, check `magarine inbox --project <projectId>`: a failed task's reason
is shown there in full, and it is almost always either something in the
task's own instructions or a spending limit that needs raising
(`magarine project set --project <projectId> --max-spend <amount>`).

## Where things live

- **State** (your projects, tasks, and their history): a small database file
  under `~/.magarine/` by default. Set `MAGARINE_HOME` or pass
  `--state-dir <folder>` to any command to use a different location.
- **Cost**: shown per task on the board, and as a running total for the
  whole project on the board's first line.
- **Worker output**: under `~/.magarine/artifacts/` unless you gave a task
  its own shared workspace with `--workspace DIRECTORY`.

Nothing is written to your current folder unless you explicitly asked for it
with `--state-dir` or `--workspace`.
