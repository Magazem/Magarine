# Batch 10 owner walk — the first one

Performed by the Orchestrator from a fresh shell, following **only** the root `README.md`,
as a person who has never seen this project. Every point where I needed something the
README does not say, or where the product behaved in a way that would mislead the owner, is
a finding. This is the new definition of done: *the owner can go from a fresh state to a
completed mission using only the quickstart, and every inbox item tells them what to do next.*

**Result: four findings. The walk did not reach a completed mission.**

## What worked, and it is a lot

- `magarine` was on the PATH in a brand new shell. `npm install -g .` holds.
- `magarine doctor` ran, printed one readable line per check, and **exited 1 because one
  line was FAIL** — the "worst line" rule is real. (My first reading said exit 0; I had
  captured `sed`'s exit code through a pipe, not the command's. Corrected before reporting.)
- `magarine project create` printed the id exactly as the README promises.
- `magarine plan` accepted a real markdown scope file through `--mission "$(cat ...)"`,
  created a manager ticket, and the board showed it OPEN with cost $0.00.
- `board` and `inbox` both ran and read clearly.

## Finding 1 — `doctor` raises a FAIL the owner cannot fix, at step one

```
FAIL  pnpm   could not run pnpm via its resolved path
              (spawnSync C:\Users\yazan\AppData\Roaming\npm\node.exe ENOENT).
```

`pnpm --version` works perfectly when typed. The FAIL is caused by a defect in our own
`resolveExecutable`, not by anything on the owner's machine.

The README says **"Fix anything marked `FAIL` before continuing."** So the instruction we
wrote tells the owner to stop and fix something that is not broken, on the first command
they run, and `doctor` exits 1 so any script halts too. **This is the worst finding here,
because it is the first impression and it is unfixable by them.**

### The underlying defect, which is broader than `doctor`

`resolveExecutable` mis-parses npm `.cmd` shims that contain a conditional
`IF EXIST "%dp0%\node.exe"` branch — it takes that quoted path literally even though the
shim falls through to bare `node` at runtime.

| input | resolved to |
|---|---|
| `pnpm` | `...\npm\node.exe` — **a file that does not exist** |
| `npm`  | `...\packages\core\NODE_EXE=%~dp0\node.exe` — **parsed garbage joined to the cwd** |
| `claude` | correct, *on this machine only* |

**`claude` resolves correctly here by luck**: that shim has a real `claude.exe` beside it.
This is the same function the adapter uses to find the worker tool, so on a machine whose
`claude` was installed differently the product's core dependency could fail the same way.
Lives in shared code in `process.ts`, not the POSIX branch.

## Finding 2 — there is no way to list your projects

The command set is `project create` and `project set`. There is no `project list`.

The README says the id from step 1 is used "in every command below", and never says how to
get it back. **Close the terminal and the project is unreachable.** I hit this immediately:
I tried `magarine project list`, got the usage line, and had to scroll back to recover the id.

## Finding 3 — read commands accept a project that does not exist, and say nothing

```
$ magarine board  --project proj_does-not-exist-at-all
Project spend: $0.00 (no cap set)
(no tickets)                                   exit 0

$ magarine inbox  --project proj_does-not-exist-at-all
(inbox is empty)                               exit 0

$ magarine status --project proj_does-not-exist-at-all
                                               exit 0   (prints nothing at all)
```

Mistype or paste a stale id and the owner is shown a **plausible, calm, empty board** and
concludes their work vanished or never ran. Exit 0 means a script sails past it too.

This batch harmonised the two ticket-*creation* paths so both validate the project. **Nobody
looked at the read paths.** `plan` and `ticket add` now refuse an unknown project by name;
`board`, `inbox` and `status` accept anything.

## Finding 4 — a scope document becomes the ticket title, and mangles the board

The README teaches `--mission "$(cat my-project-scope.md)"`. Doing exactly that produced:

```
tkt_f3dcdfe6…	OPEN	[MANAGER] Plan: # Scope: a tiny reference on SQLite journal modes

Write…	attempts 0/3	cost $0.00
```

The raw markdown, newlines and all, is embedded in the title, so one board row breaks across
several lines. With a real scope document this is unusable — and **the owner has told us in
their own words that handing over a scope document is exactly what they want to do.**

## Not reached: a completed mission

Step 3 (`magarine serve --adapter claude`) is where money is spent, so the walk stops here
pending owner-approved budget. **The claim that a real mission completes end to end via the
README's exact steps is therefore unverified**, by me and by Role Q, which said so itself
rather than implying otherwise.
