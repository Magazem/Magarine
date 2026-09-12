# Batch 1 close-out

Prepared by the Orchestrator. Every claim below was re-verified independently on the
owner's Windows machine; nothing here rests on a specialist's own report.

Roles: A Core Engineer, B AionUi Access Investigator, C Adapter Spike Engineer.
All three delivered. All three are retired. Deliverables are files, listed per role.

---

## 1. Verdict

**Batch 1 closes.** All three roles met the bar you set: complete and honest reports,
ugly findings included, untested items marked rather than asserted.

One role failed my verification on first submission and was sent back. Details in §2.

---

## 2. Role A — core engine

Deliverable: `packages/core/`, README at `packages/core/README.md`.

### What I ran myself

Cold checkout (`rm -rf node_modules pnpm-lock.yaml; pnpm install; pnpm test`):

```
tests 53
pass 53
fail 0
duration_ms 5168.3
```

No build step, no native modules, zero runtime dependencies, `engines.node >= 24` pinned.

Single write site for ticket status, my grep, not theirs:

```
src/stateMachine.ts:129: UPDATE tickets SET status = ?, attempt_count = ?, updated_at = ? WHERE id = ?
```

Exactly one. `store.ts` writes `runs.status`, a different table.

### The bug I found, and why it matters beyond itself

The first submission passed its own 45 tests. I drove the CLI by hand and dependencies
were not enforced: a dependent ticket ran to completion while its blocker had not started.

Root cause: `ticket add` resolved readiness at creation, when the ticket had no
dependencies yet, so it was promoted to READY. A later `dep add` attached a blocker but
nothing demoted it, and the scheduler trusted the stored status.

**The tests missed it because they wired dependencies before resolving readiness. The CLI
forces the opposite order, because you cannot reference a ticket that does not exist yet.**
The suite tested the scheduler's logic correctly and never tested the sequence a person
must type. I consider this the most transferable lesson of the batch and it is now
recorded in the regression test's comments.

Fixed at both the mutation point and the scheduling point. I verified the fix by replaying
my original reproduction by hand, and separately by forging a READY row with raw SQL,
bypassing the state machine entirely. The scheduler refused to run the forged row. The
defence is real, not decorative.

### Also landed

- `usage_json` on `runs`, via migration `0002`, with a test proving a database at `0001`
  upgrades without re-running `0001`. Your cost-per-run requirement is satisfied in batch 1.
- Unknown CLI flags now exit 1 naming the bad flag and listing valid ones, before touching
  the database. Previously they were silently dropped and surfaced as a foreign key error.

### Open item from Role A

`process.ts` `stop()` kills only the direct child, not a process tree. Untestable in this
batch because no adapter spawns anything real. **This meets the same finding from Role C.**

---

## 3. Role B — AionUi access

Deliverable: `docs/spikes/aionui-access.md`. Nine questions, all labelled.

### Recommendation

No viable path today for AionUi to hold worker-adapter duty via any credential. Under the
owner's rule that the product holds no AionUi login, this is settled rather than a gap.

**HARD: no legitimate route exists** for a credential-less external process to obtain a
token for `/api/teams` or `/api/conversations`. Both named leads were run down:
`/api/auth/internal/users/{id}/jwt-secret` is a per-user signing-secret rotation route
behind the same CSRF gate; `AIONCORE_BOOTSTRAP_SECRET` is a process-startup config secret,
not a per-request credential. Every plausible route is CSRF-gated in front of the check.

**The reversed design is open and its prerequisites are confirmed.** Scheduling exists and
works from a team-owned caller; standing conversations exist by demonstration; outbound
HTTP from an agent to localhost is confirmed. The round trip was not prototyped, per
instruction.

**Unrequested finding worth carrying:** a team-owned conversation is blocked outright from
`conversation create` and `session send-message` (403 `caller_is_team` / `sender_is_team`).
Even the development-time bridge only works from a plain non-team conversation. I
reproduced this myself from a different conversation and got the identical error code.

### Role B UNKNOWNs

1. **Runtime token expiry.** The CLI works from a scrubbed environment, but whether the
   token has a TTL, and what it is, could not be determined without crossing the no-secrets
   rule. Correctly left unknown.
2. **How the backend authenticates CLI-originated requests.** `diagnose http get` returns
   real data where a raw bearer call gets 401, so the mapping is internal and different from
   the public middleware. Not inspected, because inspecting it would mean reading headers
   that likely carry credential material.
3. **Whether the Electron app exposes a token anywhere by design.** Searched the data root;
   no port/pid/token file found. Absence of evidence, not evidence of absence.
4. **Upstream AionCore source not fetched.** Allowed by the task if public; treated as out
   of scope for local verification. If you want this closed, it is a cheap follow-up.
5. **Whether `conversation create` accepts an arbitrary workspace and assistant_id.** The
   schema places no restriction, but every attempt was rejected at `caller_is_team` before
   the schema was evaluated. Would need a non-team conversation to settle.

---

## 4. Role C — Claude Code adapter spike

Deliverables: `docs/spikes/claude-cli-adapter.md`, `spikes/claude-cli/`.

### Recommendation

Viable as the first worker, with two hard caveats that belong in the daemon, not the adapter.

### What I ran myself

Reran their script: exit 0, schema-valid `result.json`, `hello.txt` written, 17.5s,
workspace under the system temp directory. The Windows fix reproduces.

Secret scan across the report and every raw output: clean. All nine real-run workspaces
under `os.tmpdir()`; no run pointed at our tree. Blast radius rule held.

### Findings that change the architecture

1. **Windows spawn corruption.** `spawn(..., {shell:true})` silently corrupts the schema
   argument; `claude.cmd` with `shell:false` throws EINVAL. Workaround is a POSIX-quoted
   relay. This blocks everything until solved and it lands on Role A's `process.ts`.
2. **`--allowedTools` had no effect.** The worker wrote files with only `Read` allowed, and
   nothing was logged as denied.
3. **`--disallowedTools` was routed around** by spawning a subagent, at triple the cost and
   four times the turns. **Tool restriction is not a sandbox boundary.** Containment must
   come from the workspace, and results must be verified independently rather than trusted.
4. **Cancellation does not work.** Killing the spawned handle did not stop the real process;
   it ran to completion ~28s after the kill signal.
5. **`--max-turns` does not exist** in CLI 2.1.261. The batch 1 spec assumed it did. Only
   `--max-budget-usd` exists.
6. **Exit code alone is not a failure signal.** Not-logged-in is exit 0 with `is_error:true`
   inside the JSON; malformed schema is exit 1 with plain-text stderr and no JSON at all.
7. **`stream-json` (with `--verbose`) is usable** for activity logging without an LLM.
8. **Per-run floor: ~17.7–18.2s and ~$0.36–0.37** for a trivial one-file task, dominated by
   ~16k cache-creation tokens, not the task. This is the floor price of every ticket.

### Role C UNKNOWNs

1. **Whether killing the process leaves an orphaned OS process.** Machine was too noisy with
   unrelated team sessions to be certain. Marked unknown rather than asserted. **This is the
   one that matters**, and it meets Role A's `stop()` limitation.
2. **Why the "worker never writes the file" mode did not reproduce.** The forced failure did
   not fail as intended and the reason was not determined.

### Spend

Nine real runs, ~$3.86 recorded across run outputs; the role reported ~$4.41, i.e. it
rounded against itself. My verification run added roughly one more dollar's worth at most.
Within the owner's "handful of tiny runs".

---

## 5. Where your pre-stated bar lands

You ruled: Claude Code is adapter one, conditional on a schema-valid run, plus a way to
enforce a wall-clock timeout and end a run so no worker outlives the daemon's decision.

- Schema-valid run: **met**, verified by me.
- Reliable kill: **not met**. Cancellation failed and the orphan question is unknown.

By your own pre-stated rule this means the ruling **holds provisionally** and batch 2 opens
with a process-supervision task ahead of adapter work. I have not treated that as decided;
it is stated here so you can confirm or change it.

---

## 6. Policy items you set, and what I did

1. Specialists shut down when work is done — **done**, all three retired.
2. You stay lean — **respected**; I batched everything into this one file rather than waking
   you per event.
3. Every deliverable is a file — **done**, including this report.
4. No wakeups to keep a cache warm — **none scheduled**.

---

## 7. What I need from you for batch 2

1. Confirm or change the provisional adapter-one ruling given the failed kill.
2. Decide whether process supervision is a task inside batch 2 or its own spike, given that
   two independent roles hit the same wall from different directions.
3. Decide whether the tool-restriction finding changes the workspace design. If a worker
   cannot be restricted by flags, isolation has to come from where it runs.
4. Say whether any Role B unknown is worth closing now, particularly upstream source and
   token expiry, or whether they stay open until the AionUi adapter batch.
5. The per-ticket floor price of ~$0.37 and ~18s is now a known quantity. Tell me if that
   changes anything about what the system should be willing to spawn a worker for.
