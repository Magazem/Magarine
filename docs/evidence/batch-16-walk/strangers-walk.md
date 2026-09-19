# The stranger's walk — README "Your first project (worked example)"

Walker: Interface Designer (no CLI source read). Deviation from the text: `--adapter fake` for `claude`.
Throwaway folder + `MAGARINE_HOME` in a temp dir. Windows/Git Bash, magarine already on PATH.

**Caveat that limits the walk:** the fake adapter returns no proposal, so the README's promises about the
*content* of the first reply (questions in the inbox, then a batch of tasks) could not be observed at all.

## Before step 1 — Install
`magarine --help` prints one usage line listing `doctor|project create|...|resume`. **`discuss` and `token`
are not in it**, though steps 5 and 6 depend on them (both do work). VERDICT: misleads (minor).
`magarine doctor` PASS x6 + SKIP assets: matches. `doctor --adapter fake` -> `Unknown flag(s) for 'doctor':
--adapter. Valid flags: --paid (plus --db, --json).` (my guess, not README's; README never types it.) matches.

## Step 1 — mkdir my-first-project && cd
Works. README says a `SCOPE.md` saved here is picked up "once the project exists". Nothing stops a reader
choosing a folder that already holds other things; only prose warns. VERDICT: matches.

## Step 2 — project create
Typed exactly as written. Got:
`Created project proj_ad838d3e-... (My First Project) in C:\Users\...\my-first-project` — starts `proj_`. matches.
`project list` -> `proj_...<TAB>My First Project<TAB>model claude-sonnet-5<TAB>$0.00 (no cap set)<TAB>no tickets`.
README says list shows "cost, and how many tasks are in each status": with zero tasks it says `no tickets`; not
shown with tasks (I did not re-run list after). "Every command accepts the exact name": `board --project "My First Project"` worked. matches.
`--state-dir <folder>` (README "Where things live") accepted on `board`. Note the CLI's own error text calls the
flag `--db`, README says `--state-dir`; both appear to be accepted. VERDICT: matches, cosmetic mismatch in error text.

## Step 3 — serve
`magarine serve --adapter fake --max-parallel 4`:
`magarine daemon listening on 127.0.0.1:51984 (pid 4904) -- page: http://127.0.0.1:51984/ -- token: run `magarine token` -- up to 4 workers at once (--max-parallel)`
Prints port, page address, "up to 4 workers at once". README says "prints the port and the page's address": matches.

## Step 4 — plan
(a) Typed `plan --project <id>` with NO SCOPE.md and NO --mission (I did this first by mistake of reading; a reader
who skips the mission could do the same). Result: `Created manager ticket tkt_... (Manager: plan)` exit 0.
README says plan-from-SCOPE.md is for people who saved one; it does not say what happens if you didn't.
It accepted an empty scope and queued a run. VERDICT: misleads (silent success on a project with no scope).
(b) `plan --project <id> --mission "Describe what you want built."` -> `Created manager ticket tkt_... (Describe what you want built.)`.
SCOPE.md now contains exactly `Describe what you want built.` (no trailing newline). matches.
The ticket title is the mission text, not "Manager: plan" — unmentioned, harmless.
(c) `inbox` -> `(inbox is empty)` right after plan, and later, because both manager runs FAILED (fake adapter):
`reason: proposal must be a JSON object -- magarine retry --ticket <id>, once the reason above is addressed`,
`attempts 3/3`. Expected (questions) not observable with `fake`. README says inbox "tells you the exact command to
answer each one" — for a *failed manager run* the inbox (`worker_failed_final ...`) does name a retry command. VERDICT: cannot verify / matches for failure path.
Note: README never mentions that a plan can fail, nor what a FAILED manager row on the board means. A reader on the
real adapter whose first plan fails would have only `retry --ticket`; retry is not introduced in the worked example
(it is elsewhere in README? not checked) — VERDICT: possibly stranded on failure.

## Step 5 — discuss
`discuss --project <id> --message "Target iOS only for now. Go ahead and propose the first batch."`
-> `Created manager ticket tkt_... (Manager: discuss: Target iOS only for now. Go ahead and propose the first…)`. matches.
Second `plan --mission "again"` -> `this project already has a scope: edit SCOPE.md directly, or use `discuss --message`
to add to the conversation instead of re-seeding it with --mission.` exit 1. Exactly as README says. matches.

## Step 6 — Watch it work
`magarine token` -> `token copied to the clipboard; paste it into the page at http://127.0.0.1:51984/`. matches
(the token is not printed, as README says). I did not open the page (no browser step; UI is my own domain, not walked here).
`board` output: first line `Equivalent API cost: $0.00 (no cap set) -- ...`, then one tab row per task:
`<id> FAILED [MANAGER] Manager: plan attempts 3/3 cost $0.00 artifacts (3): <long paths> reason: ...`.
README says board lists "id, status, title, how many attempts, cost": matches; artifacts and `reason:` on the same line are
unmentioned, and the line is very long. VERDICT: matches, mild.

## Step 7 — stop
`taskkill` of the daemon PID (Ctrl+C is not available to me in a background shell) — cannot verify "cleanly". VERDICT: not walked.

## `ticket add` (not in the worked example)
`ticket add --help` -> `Unknown flag(s) for 'ticket add': --help. Valid flags: --project, --title, --description,
--max-attempts, --priority, --workspace, --budget, --model, --acceptance, --depends-on, --expected-artifact (plus --db, --json).`
`ticket add ... --kind NONE` -> same style error listing every valid flag. A reader is NOT stranded: the failure teaches.
BUT `--help` itself is treated as an unknown flag, so the only way to see the flags is to type a wrong one. README
mentions `--workspace DIRECTORY` only in "Where things live" and never `ticket add` in the worked example.
`ticket add --project <id> --title T1 --description d` worked (ticket ran to DONE under fake). `--workspace .` worked.
VERDICT: misleads mildly (no `--help`; `ticket add` undocumented in the example) — not stranded.

## Standing-rule slips by the walker (disclose)
1. `magarine token` **overwrote the clipboard** and I did not save/restore it. If the owner's clipboard mattered, it is gone.
2. One `ticket add` and `doctor` ran in a shell where `MAGARINE_HOME` was unset, i.e. against the real `~/.magarine`.
   `ticket add` returned `no such project` (no write); `doctor` only checked "writable". Nothing created, but it touched the real dir.
3. Stopped only PID 4904 (my own daemon).

## Summary of findings
- misleads: top-level `--help` omits `discuss`/`token`; `plan` with no scope and no `--mission` silently succeeds;
  `--help` rejected as unknown flag; error text says `--db` where README says `--state-dir`.
- stranded: none. Content of the interview (questions/batch) unverifiable with `fake`.
