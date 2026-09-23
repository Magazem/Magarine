# Magarine — Batch 20: a project can be started from the window

Author: lead. Date: 2026-09-23. Tree at `cfa004d`. Batch 19 is built and waits on the owner's walk;
the owner, away, said *"fix that or whatever and continue batching"*.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What exists, HARD

- Batch 18's close-out and batch 19's spec both carried it: **"Project creation in the window,
  batch 20."** Today a project can only be created with `magarine project create` in a terminal.
- `cli.ts` 713-760: `project create` resolves `--dir` (default: the current directory), asks
  `projectReadiness` (`readiness.ts` 104-133) about the row it is about to write, then calls
  `createProject` with `workspaceRoot = dir` and `scopePath = dir/SCOPE.md`, then announces an absent
  scope document (ruling 29). Batch 12 ruling 1: a project has exactly one directory.
- `projectReadiness` refuses a missing workspace root, an unsafe one (`validateWorkspaceRoot`: not
  the home directory, not the state directory), and an unreadable scope file. An ABSENT scope passes
  and is announced, never treated as empty.
- There is no `POST /projects`. `GET /projects` exists (`daemonApi.ts` 629).
- 1B built `writeScopeTextAtomic` (`manager.ts`) for `PUT /projects/{id}/scope`.

## 1. Ruling 42 — the window can start a project, with the terminal's exact rules

**One creation path.** The body of `project create` becomes a function in `src/commands/`, and both
the CLI and a new `POST /projects` call it, so the two cannot drift. It keeps `projectReadiness` as the
gate and `createProject` as the write, unchanged.

**The route.** `POST /projects` with `{ name, dir, description?, defaultModel?, managerModel?,
verifierModel?, maxParallel?, scopeText? }`, behind the token.

- `dir` is an absolute path the owner types. A browser cannot open a folder picker onto the daemon's
  disk, and the page does not pretend to. **The directory must already exist**; a missing one is
  refused in one sentence saying so. The daemon never creates directories on the owner's disk because
  a web page asked it to.
- Models are validated against `pricing.ts`, the cap with the existing rules, all fields before any
  write (1B's discipline), one sentence per refusal.
- `scopeText`, when given: written atomically to `dir/SCOPE.md` **only if no SCOPE.md exists there**.
  An existing scope document is never overwritten from a create form; that is refused in one sentence
  and nothing is created. When `scopeText` is absent, an absent SCOPE.md is announced exactly as the
  CLI announces it.
- Two projects on one directory: the builder reports what `createProject` does today and does NOT
  change it in this batch. If it permits it, the lead rules separately.

**The page.** A "New project" control beside the project selector opens a form: name, directory,
optional description, optional starting scope, and the models and cap under a disclosure defaulting
to "use the machine default". On success the new project is selected. Every refusal is the daemon's
own sentence, and nothing typed is cleared by a refusal or by a poll. `ELEMENT-FIELD-TABLE.md` rows go
in before the page draws anything. `new Notification` and `beforeunload` stay prohibited.

## 2. Mini-phases

| Mini-phase | Content | Depends on |
|---|---|---|
| **20A** | The shared creation function, `POST /projects`, the CLI moved onto it | ruling 41 merged (both edit `cli.ts`, one tree) |
| **20B** | The page's New project form | 20A reviewed and merged |

## 3. Acceptance

1. `magarine project create` behaves exactly as before, proven by the existing CLI tests unchanged.
2. `POST /projects` with a valid existing directory creates the project, visible in `GET /projects`.
3. A missing directory, the home directory, the state directory, an unknown model and an invalid cap
   are each refused in one sentence, and nothing is written.
4. `scopeText` with no SCOPE.md creates the file atomically; with an existing SCOPE.md it is refused
   and the existing file is byte-for-byte unchanged.
5. 401 without a token.
6. The page creates a project, selects it, and shows the daemon's sentence on every refusal without
   clearing the form; typing survives a poll.
7. The suite passes; each mutation fails a named test.

## 4. Not in this batch

Deleting or archiving a project. The owner has not asked for it, and it is the one operation here
that destroys something. It gets its own ruling if they do.

## 5. Amendments, 2026-09-23, from the 20A build

The engineer reported two limits plainly rather than hiding them; both are ruled.

- **The SCOPE.md race breaks the one hard promise.** `writeScopeTextAtomic` renames a temp file into
  place, and a rename REPLACES an existing target, so a `SCOPE.md` appearing between the pre-check and
  the write would be overwritten. For CREATION the write is now an exclusive create that fails if the
  file exists (link into place, or open with `wx`); on that failure the whole transaction rolls back
  and the refusal is the same sentence as the pre-check. `PUT /projects/{id}/scope` keeps its replace
  semantics, because replacing is what it is for.
- **A second project on one directory is refused.** HARD, the engineer ran it: `createProject`
  permits two projects naming the same directory, and they would then share one `SCOPE.md` and one
  workspace, with two Managers editing the same document. The shared creation function now refuses a
  directory that is already an existing project's workspace root, naming that project, comparing
  normalised absolute paths case-insensitively on Windows. The CLI and the route refuse alike.
  **Existing rows are not touched**: a database that already holds duplicates keeps them, and there
  is no migration.
