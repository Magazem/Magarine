# Magarine — Batch 10: the Linux leg, and the cross-seam rule applied backwards

Author: Strategist. Date: 2026-09-14. Follows `batch-9-closeout.md` and `linux-leg-design.md`.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What I verified myself after the close-out

HARD:
- Read the open items and questions of `batch-9-closeout.md`; forty-four commits on top of the upload, tree clean.
- Only two test files pair the real adapter with the scheduler's tick: the manager spawned-pipeline test from batch 9 and the CLI adapter-flag tests, which check flags rather than outcomes. Every other result status and failure class is tested on one side of the join or the other.
- Docker 29.5.2 is installed but the Docker Desktop engine is not running: the named pipe does not exist. Starting Docker Desktop is a state change on the owner's PC; it is benign, reversible, and in service of the Linux leg the owner asked for, so the Orchestrator starts it and records whether it comes up.

## 1. Rulings on the three close-out questions

1. **Yes, the cross-seam rule applies backwards, and it is Role O's whole job.** A rule that only applies forward is the shape it was written to prevent, as the close-out says. One spawned-pipeline test per result status and per failure class, each driving the real adapter's classification and the scheduler's tick with recorded or synthetic tool output: `done`, `review`, `needs_user_decision`, `failed`, `budget_insufficient`, malformed result, artefact not found, `budget_exceeded` from the recorded subtype, timeout, and the not-logged-in `adapter_unavailable` path. The two small items from the close-out ride along: `manager_proposal` reachable from the fake outcome list so `plan` then `run --until-idle` works without a daemon, and `ticket add` validating the project the way `plan` does, with the typed error.
2. **The Linux leg is next.** It is Role P, per `linux-leg-design.md`, with the container leg first because Docker exists.
3. **Automatic Manager triggers are not due yet.** They come after the Linux leg and the AionUi pull shape, and when they come they carry two constraints from the start: a per-project cap on Manager invocations per day, and never firing twice for the same failure. A Manager that replans on every final failure with no cap is a loop that spends money; the inbox already carries every final failure to the owner, which is the document's policy.

### Two process rules, from the close-out's own record
- **Soak measurements are exclusive.** While an engineer measures leaks, flakes, or timing, nobody else runs the suite or a daemon on this machine. The engineer announces start and end; the Orchestrator verifies afterwards, not alongside.
- **Mutation-test the claim.** A test that passes is asked to fail: break the property it claims to guard and confirm the test sees it. Role N did this unprompted; it is now expected for every test that guards a rule.

## 2. Batch 10: two roles with disjoint files

### Role O: Seam Coverage Engineer — model tier: sonnet, medium effort
Owns test files under `packages/core/src`, `adapters/testFixtures/`, `adapters/fakeAdapter.ts` for the outcome list, `cli.ts` for the fake outcome flag and the `ticket add` validation, and the README's test section. Nothing else. Does not commit.
Deliver:
1. The spawned-pipeline test per status and class listed in ruling 1, each with a fixture that is either a recording from `spikes/claude-cli/runs/` or the batch fixtures, or synthetic tool output built from the recorded shapes and labelled so.
2. Each test mutation-checked: the report lists, per test, what was broken to prove it fails.
3. `manager_proposal` in the fake outcome list; `plan` then `run --until-idle` tested end to end with the fake.
4. `ticket add` project validation aligned with `plan`.
Acceptance: `pnpm test` green, twenty cold runs by the Orchestrator on a quiet machine; the report's mutation list checked by the Orchestrator for at least three tests by repeating the mutation.

### Role P: Linux Leg Engineer — model tier: sonnet, high effort
Owns `linux-leg/` and the POSIX branch of `process.ts` only. Does not commit. Follows `linux-leg-design.md` as the design; this section is the order and the bar.
Deliver, in this order:
1. **Container proof.** Docker Desktop started by the Orchestrator; if it does not come up, that is recorded and steps 2 to 4 are built unproven with a clear note. Otherwise a bare `ubuntu:24.04` container is the test bed for everything below.
2. **`1-setup.sh`**: idempotent, no `sudo`, installs Node 24 or newer from the official tarball, pnpm via corepack, the Claude Code tool into the user prefix, checks git and stops with the one `apt` line if it is missing. Every step prints PASS, FAIL, or SKIP with the command, the exit code, and one sentence on what to do. Never asks a question. Proven from a bare container twice: once clean, once re-run to prove idempotence.
3. **`3-run.sh` Phase A** in the container: versions, the suite twenty times, POSIX tree-kill proven by pid against the OS, graceful shutdown by SIGTERM proven with the daemon, the daemon lifecycle, the fake-adapter mission loop. Phase A's report from the container is committed under `linux-leg/reports/container-<date>/` as the first Linux evidence.
4. **`3-run.sh` Phase B**: the login check, skipped with a clear line when it fails; the three-ticket shared-directory run through the daemon with the Claude adapter; a live cancel from a background shell; every `usage_json`. Built and dry-run in the container against the fake adapter path where possible; the real path is the owner's.
5. **`2-login.md`** and **`4-send-back.md`** as designed; the report packer; a `README.md` in `linux-leg/` that is the only page the owner needs to read, under one screen.
6. The POSIX branch of `process.ts` loses its UNTESTED header once step 3 proves it.
Acceptance: the container Phase A report shows every check PASS; the Orchestrator reruns the container leg from a fresh container and gets the same; the owner-facing README is read by the Orchestrator as if they were the owner and every step is followable without asking.

### Orchestrator close-out for batch 10
1. Start Docker Desktop; record whether it came up. Verify and commit each role's steps in sequence; run the container leg yourself after Role O lands so it runs against the final tree.
2. Twenty cold runs on a quiet machine per the soak rule; grep the write site; repeat three of Role O's mutations.
3. No paid run is needed for Role O; state the masked paths as usual. Phase B's real path is not run by us; say so.
4. **Hand-off through the Liaison**, in the owner's words: where the directory is on the Windows drive, the one-page README, and the two non-blocking questions from the design note. The batch closes at the hand-off; the owner's report, whenever it arrives, opens the review in a later batch.
5. Report every UNKNOWN and the spend, which should be zero.

## 3. What the owner must decide or supply
Nothing blocks the batch. At hand-off, the owner receives the prepared directory and two non-blocking questions: whether Ubuntu can see the Windows drive, and free disk on the Ubuntu side.

## 4. Looking ahead, not for dispatch
Batch 11 is the AionUi pull shape, which now has a daemon API and a product-owned token to pull against. The owner's Linux report is reviewed whenever it lands. After both: automatic Manager triggers with their two constraints, `GIT_WORKTREE`, OS-level worker isolation, a static status page.
