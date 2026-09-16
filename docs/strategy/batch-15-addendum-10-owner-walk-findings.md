# Magarine — Batch 15 addendum 10: three rulings from the owner's walk

Author: Strategist. Date: 2026-09-16. Follows addendum 9. The owner's walk came back "it feels good" with one question; answering it found two defects and a defaults gap. All facts below were read by the Orchestrator from the owner's database opened read-only and from transcripts parsed for one field, then re-read by me in the tree this turn.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## Ruling 21 — expected artefacts are compared by resolved path, both sides; batch 15

### Evidence, HARD

- `scheduler.ts` 730-735: `declaredFilePaths` is a set of the declared paths exactly as the worker wrote them, tested with `.has(e.path)` against the ticket's expectation exactly as the owner typed it. String equality.
- `adapters/claudeCli.ts` 265-272, `verifyArtifacts`: declared paths are resolved against the workspace (`isAbsolute` kept, relative joined) and checked for existence and containment. That resolution happens one layer down and is not reused by the scheduler's check.
- The owner's run: expectation `index.md`, four transcripts declaring `C:\Users\yazan\index.md`, the file present and 559 bytes, four failures "expected artefact(s) not produced: index.md", one of them a manual retry at real cost. `memory.md` failed the same way once and passed when a later run happened to declare it relative.
- Ruling 16 item 3 said "the scheduler compares declared paths as strings, so the CLI does not normalise". That sentence was true of the code and wrong as a rule: real workers legitimately declare absolute paths, and the adapter already accepts them.

The effect is the inverse of batch 13's rule: delivered work shown FAILED and retried at real cost. It is a batch 15 regression and it fails real work on the first real multi-file run.

### The ruling

1. Both sides are resolved against the run's workspace root with the same function `verifyArtifacts` uses: an absolute path stays as resolved, a relative one is joined to the workspace. Equality is on the resolved strings. The failure message keeps naming the expectation as the owner typed it.
2. The CLI and the route still store the expectation as given (ruling 16 item 3 stands for storage); the scheduler resolves at comparison time. Ruling 16 item 3's rationale is corrected by this addendum.
3. Tests, mutation-checked, in `scheduler.test.ts`: expectation `index.md`, declared `<workspace>/index.md` absolute, passes; declared absolute under a different directory, fails naming `index.md`; declared relative, passes as today. Restore string equality and the first test fails.
4. UNKNOWN whether case-differing paths occur on Windows in practice; `verifyArtifacts` compares exact strings today and this ruling matches it rather than inventing a normalisation. Recorded, not handled.
5. The owner's `index.md` ticket passes on retry once this lands. The Orchestrator tells the owner that through the Liaison, with the fix landed, not before.

Placement: batch 15, `scheduler.ts` and its test only. The file is free; ruling 20's engineer is in `cli.ts`. Same engineer, separate task and commit, after ruling 20.

## Ruling 22 — `project create` and `project set --dir` refuse an unsafe workspace root; batch 15

### Evidence, HARD

- `cli.ts` 544: `--dir` defaults to the current working directory, by design ("the same way `git init` works").
- The owner ran it from their home directory. Every run's workspace was `C:\Users\yazan`, and workers with write access treated the whole home folder as their boundary. Four files now sit in the owner's home directory.
- Batch 2's premise: the workspace is the boundary. Here the boundary was the home directory. Nothing warned.

### The ruling

1. `project create` and `project set --dir` **refuse**, exit 1, when the resolved directory is any of: the user's home directory (`os.homedir()`), a filesystem root (`path.parse(dir).root === dir`), or an ancestor of or equal to the state directory (a worker inside the workspace could then edit Magarine's own database). The message names which rule fired and what to do: "make a folder for the project and run this from inside it", or "move the state directory with `--state-dir`".
2. Refuse, not warn. A warning in a terminal the owner is reading a recipe from is not read, and the consequence is a worker with write access over the home directory. There is no legitimate workspace that is the home directory or a drive root, so there is no override flag.
3. The root README's step "make an empty folder, go into it" gains the reason in one sentence: the folder is the boundary workers may write inside.
4. Tests, mutation-checked, in `commands.test.ts` or `cliRouting.test.ts`: each of the three rules refuses with its own message; a plain subdirectory is accepted; `project set --dir` applies the same check.
5. Carried to batch 16, with the reason: rows created before this rule, including the owner's demo project, can still carry an unsafe root, so the point-of-use guard belongs in the scheduler too: a run is not started in an unsafe workspace, and the project is paused with a reason naming the fix command, through the existing pause mechanism. Not batch 15, because it touches the pause path and needs its own inbox line.

Placement: batch 15, `cli.ts` and its tests, the root README. Ruling 20's engineer, same file, one more task and commit.

## Ruling 23 — parallelism: the promise on the front page must be reachable, and the cap must be settable after creation

### Evidence, HARD

- Root `README.md` lines 6-7, the product's own first sentence: it "runs an AI coding assistant on several of them at once wherever they don't depend on each other".
- The root README never mentions `--max-parallel`. The flag is documented only in the core README (453-471), which is written for engineers.
- Two caps, both defaulting to one: `projects.max_parallel_workers` (schema.ts 30, `DEFAULT 1`; cli.ts 548) and serve's machine-wide `--max-parallel` (cli.ts 883, default 1). The effective cap is the minimum (core README 460-467). So parallel work needs both flags set, and the owner-facing README names neither.
- `project set` has no `--max-parallel` (cli.ts 263), so an existing project cannot be raised at all.
- The owner's log: strict serialisation across three unblocked tickets.

### The ruling

Batch 15, small and in `cli.ts`, same engineer:

1. `project set --max-parallel <n>` exists, integer of one or more, same validation as `project create`.
2. Serve's human listening line says the machine-wide cap: `... -- up to <n> workers at once (--max-parallel)`. The owner sees the number they are running under.
3. The root README's recipe shows the two flags explicitly, `project create --max-parallel 4` and `serve --max-parallel 4`, with one sentence on what a worker costs: each is a real session against the subscription's limits, so the number is the owner's choice. Defaults are not changed in batch 15; a default that spends the owner's session limits four ways is not a change to make in the hour before a walk.

Batch 16, ruled now so it is designed once:

4. The two-caps design is the defect. A project's own cap should mean "this project's ceiling, if it has one", not "one unless told otherwise". `projects.max_parallel_workers` becomes nullable with null meaning "no cap of its own, the daemon's ceiling governs", by migration with an upgrade test; `computeProjectCap` treats null as unbounded on the project side. Existing rows keep their explicit 1, and the migration's note says why: they were created under the old meaning. After this, the owner sets one number, on serve, and the front-page sentence is true by setting one flag.
5. The board shows the cap in the fleet header, "N of M slots", because the owner asked "why not four at once" and the page could not tell them. Field-backed: the daemon knows both numbers.

## The process note

Two of the three came from the Orchestrator's recipe, and they said so. The recipe was written from the design's intent, the same class as the token instruction in addendum 9: owner-facing steps are run before they are written. The walk instructions are an artefact and are verified like one. That is now stated twice in two addenda and goes into the handover's rules.

## What closes batch 15

Rulings 20, 21, 22 and the batch 15 part of 23 landed and verified, then the owner's walk re-run from step one by the Orchestrator and then by the owner, with the owner's `index.md` ticket retried and passing.
