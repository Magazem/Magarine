# Batch 16 closing condition, part 1: a real legacy project pauses and is fixed

Authority: `docs/strategy/batch-16-addendum-3-beta-and-checkpoint.md`, the closing condition. Run against the tree at `5c7fb66` plus the uncommitted `status` fix (the "slots not reported" change; it does not touch anything observed below). **No product code was changed to make this run.**

**HARD** = I ran it and read the output below. **NOT OBSERVED** = I could not make it happen.

## How it was built (temp state dir only; the owner's `~/.magarine` was never read, copied or used)

`legacy-fixture.walk.mjs` (this directory) builds a database by running the REAL migrations 0001-0013 from `src/db/schema.ts` (not a hand-written schema), inserts two legacy rows and three tickets, then starts a REAL `node src/cli.ts serve --adapter fake --max-parallel 2` on it and drives the CLI and `GET /board` against it. Reproduce: `node docs/evidence/batch-16-walk/legacy-fixture.walk.mjs <path-to-packages/core>`. The daemon token is read from `daemon.json` to authenticate `GET /board` and is never printed.

- `proj_legacy_a`: `workspace_root` NULL **and** `scope_path` NULL (the owner's row shape: created 13 Sep, both null), explicit `max_parallel_workers` 3, one manager ticket + one work ticket (both fake-scripted to `hang`).
- `proj_legacy_b`: `workspace_root` set, `scope_path` NULL, explicit `max_parallel_workers` 2, one work ticket (fake-scripted `succeed`).

## Transcript (real output, temp path and port scrubbed to `<T>` / `<port>`)

```
### 0. The legacy database, BEFORE any Magarine process opens it

applied migrations: 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013
projects: [{"id":"proj_legacy_a","max_parallel_workers":3,"workspace_root":null,"scope_path":null},{"id":"proj_legacy_b","max_parallel_workers":2,"workspace_root":"<T>/proj-b","scope_path":null}]
runs before: [{"n":0}]

### 1. Start a real `serve` (fake adapter, --max-parallel 2) on the legacy database

serve listening line (--json): {"pid":<pid>,"port":<port>,"stateDir":"<T>\\state"}

### 2. After ticks: did anything run? (raw db) and what state is each project in

runs: [{"n":0}]
tickets: [{"id":"tkt_a_manager","status":"READY"},{"id":"tkt_a_work","status":"READY"},{"id":"tkt_b_work","status":"READY"}]
projects: [{"id":"proj_legacy_a","max_parallel_workers":3,"paused":1,"pause_reason":"missing_workspace_root"},{"id":"proj_legacy_b","max_parallel_workers":2,"paused":1,"pause_reason":"missing_scope_path"}]
applied migrations now: 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014

### 3. The pause a human sees: board, inbox

GET /board?project=proj_legacy_a => pauseReason="missing_workspace_root"
   pauseMessage: this project has no directory, so no worker can start -- run `magarine project set --project proj_legacy_a --dir <folder>`
   tickets: [["tkt_a_manager","READY"],["tkt_a_work","READY"]]
GET /board?project=proj_legacy_b => pauseReason="missing_scope_path"
   pauseMessage: this project has no scope document path, so no worker can start -- run `magarine project set --project proj_legacy_b --dir <folder>`
   tickets: [["tkt_b_work","READY"]]
$ magarine inbox --project proj_legacy_a    # inbox for legacy-a
proj_legacy_a	project_not_ready	this project has no directory, so no worker can start -- run `magarine project set --project proj_legacy_a --dir <folder>`
[exit 0]
$ magarine inbox --project proj_legacy_b    # inbox for legacy-b
proj_legacy_b	project_not_ready	this project has no scope document path, so no worker can start -- run `magarine project set --project proj_legacy_b --dir <folder>`
[exit 0]
$ magarine board --project proj_legacy_b    # human board for legacy-b
PAUSED: this project has no scope document path, so no worker can start -- run `magarine project set --project proj_legacy_b --dir <folder>`
Equivalent API cost: $0.00 (no cap set) -- on a subscription, the real constraint is session limits, not dollars.
tkt_b_work	READY	work in b	attempts 0/3	cost $0.00
[exit 0]

### 4. project list (text and --json readiness)

$ magarine project list    # text
proj_legacy_a	legacy-a	model claude-sonnet-5	$0.00 (no cap set)	READY 2	needs --dir
proj_legacy_b	legacy-b	model claude-sonnet-5	$0.00 (no cap set)	READY 1	needs --dir
[exit 0]
$ magarine project list --json    # readiness only
[
 { "id": "proj_legacy_a", "readiness": { "rule": "missing_workspace_root", "fix": "magarine project set --project proj_legacy_a --dir <folder>" } },
 { "id": "proj_legacy_b", "readiness": { "rule": "missing_scope_path",     "fix": "magarine project set --project proj_legacy_b --dir <folder>" } }
]
   (the driver prints this pretty-printed over more lines; compacted here, same content)

### 5. status and GET /board slots while everything is paused

$ magarine status    # status
daemon running: pid <pid> on 127.0.0.1:<port> -- page: http://127.0.0.1:<port>/ -- 0 of 2 slots in use
[exit 0]
slots @ paused: status --json => {"used":0,"cap":2}   GET /board => {"used":0,"cap":2}

### 6. Fix legacy-b: `project set --dir` (no separate resume command); its worker then runs

$ magarine project set --project proj_legacy_b --dir <T>\proj-b    # fix b
Updated project proj_legacy_b
[exit 0]
legacy-b after fix: pauseReason=null tickets=[["tkt_b_work","DONE"]]
projects: [{"id":"proj_legacy_a","paused":1,"pause_reason":"missing_workspace_root","workspace_root":null,"scope_path":null},{"id":"proj_legacy_b","paused":0,"pause_reason":null,"workspace_root":"<T>\\proj-b","scope_path":"<T>\\proj-b\\SCOPE.md"}]
slots @ after b fixed and finished: status --json => {"used":0,"cap":2}   GET /board => {"used":0,"cap":2}

### 7. Fix legacy-a (both directory fields were NULL): manager + worker start, slots fill the ceiling

$ magarine project set --project proj_legacy_a --dir <T>\proj-a    # fix a
Updated project proj_legacy_a
[exit 0]
legacy-a after fix: pauseReason=null tickets=[["tkt_a_manager","IN_PROGRESS"],["tkt_a_work","IN_PROGRESS"]]
$ magarine status    # status
daemon running: pid <pid> on 127.0.0.1:<port> -- page: http://127.0.0.1:<port>/ -- 2 of 2 slots in use
[exit 0]
slots @ two workers running: status --json => {"used":2,"cap":2}   GET /board => {"used":2,"cap":2}
runs: [{"ticket_id":"tkt_a_manager","status":"running"},{"ticket_id":"tkt_a_work","status":"running"},{"ticket_id":"tkt_b_work","status":"succeeded"}]

### 8. The data-loss check: max_parallel_workers across the 0013 -> 0014 upgrade

projects: [{"id":"proj_legacy_a","max_parallel_workers":3},{"id":"proj_legacy_b","max_parallel_workers":2}]
column notnull now: [{"name":"max_parallel_workers","nn":0}]
```

## Claims

1. **The daemon starts and the project does NOT run; it pauses BEFORE any run, manager or worker — HARD.** Step 2: `runs` is `0` after several 200 ms ticks, every ticket is still `READY` (including `tkt_a_manager`, the manager ticket), both projects `paused: 1`.
2. **The pause reason names the rule and the exact command — HARD, with one difference from the brief.** The reason is `missing_scope_path` for `proj_legacy_b` (directory present, scope path NULL). For `proj_legacy_a` — the **owner's actual row shape, both fields NULL** — it is `missing_workspace_root`, because ruling 24's rules are ordered and "no directory" comes first. Both messages carry `magarine project set --project <id> --dir <folder>` with the real id filled in (step 3, board, inbox and human `board` all agree). So the owner's four legacy projects will read "this project has no directory", not "no scope document path"; the fix command is identical. `missing_scope_path` is only seen by a row that has a directory but no scope path.
3. **`project list` marks the row and `--json` carries `readiness` — HARD.** Step 4: both rows end in `needs --dir`; `readiness` is `{rule, fix}` for each.
4. **`project set --dir` resumes it with no separate resume command, and the work then runs — HARD.** Step 6: after the one `project set` (routed through the live daemon), `pauseReason=null`, `paused: 0`, `tkt_b_work` reaches `DONE` (`runs`: `succeeded`). Step 7: same for `proj_legacy_a`, whose manager and work tickets go `IN_PROGRESS`. No `resume` command was run. **Caveat:** the "work" is the fake adapter (`succeed` / `hang`), not a real `claude` worker; this proves the scheduling and pause lifecycle, not what a real worker does in the fixed directory.
5. **`status` and `GET /board` agree about slots throughout — HARD** at the three points sampled: paused `{used:0,cap:2}` both; after B finished `{used:0,cap:2}` both; two workers running `{used:2,cap:2}` both. Also the human `status` line reads `2 of 2 slots in use` with two runs `running` in the database. Sampled at three instants, not continuously.
6. **Migration 0014's data-loss case — HARD.** The daemon opened a database at 0001-0013 and applied `0014` (step 2); afterwards the explicit caps are unchanged (`proj_legacy_a` 3, `proj_legacy_b` 2), the column is now nullable (`notnull` 0), and the tickets pointing at the projects survived (step 3/7 show them). This is the first time 0014 ran against a database built outside its own test, though it is still a database built from the real 0001-0013 migrations, **not the owner's real database — NOT OBSERVED on real data**, by instruction.
7. Also visible: `proj_legacy_a` has an explicit cap of 3 but the machine ceiling is 2, and exactly two ran (`min(3, 2)`), so the explicit cap and the ceiling compose as designed.

## What was NOT observed

- **The owner's real database**, by instruction. Its rows may differ from these two in ways this fixture does not model.
- **A real `claude` worker or Manager run** on a fixed legacy project. The fake adapter's manager ticket simply hangs; whether a real Manager run on a freshly-fixed legacy project succeeds (the original `update_scope cannot be applied` failure) was not exercised. The pause guarantees it cannot start before the fix; what happens after is the same code path a new project takes.
- **A daemon older than this build** (the owner's pid 31044): not touched, and not started here. The "slots not reported" behaviour for it is covered by the stub-daemon tests, not by this walk.
- **The page** (Role B's pause banner) was not opened; only the JSON/CLI surfaces were read.
