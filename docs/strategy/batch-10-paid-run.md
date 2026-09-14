# Batch 10 paid run — the end-to-end claim, finally proven

Run by the Orchestrator on the owner's explicit approval of up to $1.00, against the shipped
tree (`6c7e7a6`), following the root README's own five steps with a real markdown scope
document.

**Result: the mission completed. $0.72, every ticket DONE, correct output, nothing left
behind.** This is the claim neither Role Q nor I would make this morning, and it is now
evidence rather than assertion.

## The run

```
t+20s   [MANAGER] Plan DONE | delete IN_PROGRESS | wal READY | memory READY | index OPEN
t+60s   delete DONE $0.12   | wal IN_PROGRESS
t+80s   wal DONE $0.14      | memory IN_PROGRESS
t+100s  memory DONE $0.13   | index IN_PROGRESS      <- held until all three existed
t+160s  index DONE          | all terminal
```

Two workers ran in parallel under the cap; the index was correctly held back until its three
blockers finished. The Manager planned all four tickets and the dependency itself, from the
scope file alone.

`index.md`, written last, as delivered:

```markdown
# SQLite Journal Modes

- [delete.md](delete.md) — the default rollback-journal mode; simple, single-process friendly.
- [wal.md](wal.md) — Write-Ahead Logging; readers and writers proceed concurrently.
- [memory.md](memory.md) — keeps the rollback journal in RAM for speed, no crash recovery.
```

**Total $0.72** against an approved $1.00 — the same figure as batch 9's run, which is itself
a useful signal that cost is predictable for this shape of mission.

After stopping the daemon: **zero surviving `claude.exe` beyond the pre-existing baseline, and
zero leaked `magarine-run-*` workspaces.** Production cleanup is genuinely clean.

## The budget guard fired for the first time, and exposed two real findings

The run would not start. The inbox said why, and it was right to refuse:

```
project_spend_cap_reached: starting tkt_1e74… would bring the project to $2.00 (cap $1.00)
```

### Finding 5 — `plan` has no `--budget` flag, so a cap below $2.00 can never run anything

The default per-ticket budget is `$2.00` (`store.ts:87`). `plan` exposes no way to lower it —
`--budget` exists only on `ticket add`. **So an owner who sets a $1 cap, which is exactly what
a cautious first-time user does, can never run a planned mission at all.** The cap refuses it
forever and the only fix is to raise the cap above a number nobody told them about.

### Finding 6 — after a cap fires, raising the cap is not enough, and nothing says so

The cap event pauses the project. Raising `--max-spend` does not unpause it. **The board showed
`READY` for six straight minutes with no indication anything was wrong**, and no new activity
events at all. Only the inbox held the reason, and the inbox message does not say what to do.

`magarine resume --project …` is the missing step. **I found it by guessing**, having seen
`resume` in the usage line. An owner would reasonably conclude the product was broken.

The bar for this batch is *"every inbox item tells them what to do next."* This one does not.

## What I checked that turned out to be fine

Stated because a suspicion reported as a finding is worse than no finding.

- **The README does explain stopping the daemon** (line 84, `Ctrl+C`). My first grep pattern
  missed it; the instruction is there.
- **The paid run leaked no workspaces.** `magarine-run-*` count is 0.

## A test-hygiene defect found on the way

448 `magarine-*` directories in TEMP, of which **435 are `magarine-doctor-test-*`**. Measured
by before/after around a single run: **17 leaked per run** of `doctor.test.ts`, whose
`tempStateDir()` creates a directory per test and never removes it.

It leaks nothing in production — but the twenty-run soak counts exactly those directories, so
it would have shown a climbing leak and sent me hunting a phantom. That is the batch 9 trap
exactly, where the contamination was also mine. Routed to Role Q with the measurement.

## A contamination of my own, the fifth

Role Q reported "confusing transient output… the file flipped between mutated/fixed a couple
of times while I was reading it." **That was me**, mutation-testing `process.ts` while it had
that same file open. It spotted the pattern and backed off rather than drawing a wrong
conclusion from it.

The exclusivity rule I wrote covers *measurement*. It does not cover *mutation*, and it should:
editing a file another engineer is reading is the same failure with a different surface.
