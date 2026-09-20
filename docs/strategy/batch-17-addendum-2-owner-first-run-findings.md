# Magarine — Batch 17 addendum 2: the owner's first real run of `magarine app`

Author: Strategist. Date: 2026-09-20. Amends `batch-17-spec.md` section 3 (roles) and fixes the first item of batch 18. Tree at `77a1096` with item 4b uncommitted in `packages/core/src` (HARD, `git status`).
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

The owner ran `magarine app` and said: *"it works but the issue is you can't create a project from the app and neither i know how to start the conversation with manager"*. Two findings, two different sizes, one ruling each.

## 1. Finding 1: the Manager conversation is under a tab called Scope. It enters batch 17 as a label change.

What I read (HARD):

- `ui/index.html` 114-118: three nav entries, `Board`, `Needs you`, `Scope`. 265-279: the `#conversation` region with its composer, placeholder *"Talk to the Manager — answer a question, or ask it to change something."*
- `skin-brutalist.css` 211-212 and 227-228: `#conversation` is `display: none` in the `board` and `needs-you` views; 244-247: it shares the centre with `#scope` only in the `scope` view. The CSS comment gives the reason and it is a good one: talking to the Manager about the scope while unable to see it makes neither useful.
- `app.js` 1319-1323: Send posts to `/projects/{id}/discuss`. `manager.ts` 163-168: `discussProject` invokes the Manager with the owner's message. README 140-141: with no scope document the Manager *"will start by interviewing you"*. So the composer is how a conversation starts on a fresh project, not only how a question is answered. **The feature exists and works; its door is labelled for the document, not the person behind it.**

The ruling. The tab label at `index.html` 117 becomes **`Manager`**. The hash stays `#scope`: the router, the deep links, the tests on the hash and the CSS selectors are untouched. The scope panel's own head keeps saying `Scope`, so the document is still named where it is drawn. Nothing moves between views; that is the owner's layout and they can see it from where they sit. Any test or table row that asserts the nav label text is updated to match, and nothing else changes. **OWNER TASTE:** the word. `Manager` is shipped; if they prefer `Scope & Manager` or anything else, it is one word through the Liaison and one line of HTML.

Why not more: the alternative that answers the finding better, the conversation on screen in the board view, is a grid change in the owner's own interface, and the CSS comment records a reason for the current arrangement. The stranger's walk (spec section 4 item 3) is the test of whether the label alone suffices; its task is to get one small thing done, which cannot happen without finding this tab. If the stranger stalls there, the layout question goes to the owner with that evidence rather than my guess.

Role B, item 5, before the walk: the label, the test, the table row. Sequenced after item 4b lands or is dropped, so the mutation window rule is not strained by a two-line change.

## 2. Finding 2: no project can be created in the app. It is the first item of batch 18, and its shape is fixed here so nobody waits on me.

What I read (HARD):

- `daemonApi.ts` 361: `GET /projects` is the only `/projects` route without an id. There is no `POST /projects`. The CLI is the only door in, exactly as `requirement-no-terminal-for-end-users.md` recorded.
- `cli.ts` 640-688: `project create` takes a name, an optional brief, and `--dir` defaulting to the current directory; it refuses through `projectReadiness` before writing, and announces a missing `SCOPE.md` through `scopeAnnouncement`. That is the whole of creation: a name and a directory path.
- `app.js` 1109-1150: the project selector is re-read on the board's cadence, so a project created in a terminal appears in the open window without a reload. The owner hit this themselves during the batch 16 demo and it was fixed then.

The ruling on scope. **Finding 2 does not enter batch 17.** Batch 17's closing walk has not been run, item 5 has not started, and the batch's promise is a window over the page the owner already has. Adding a daemon route and a page form to it delays the walk that puts the beta in their hands. The owner's own words a day earlier put the no-terminal requirement at late stage; what has changed is that this one piece of it is now in their way, and that makes it the first thing after the walk, not a reason to lengthen the batch. **Batch 18 opens with it**, ahead of per-ticket discussion, tags, shortcuts and the second skin, which were never things the owner had asked for by hitting a wall.

The shape, so the Orchestrator can brief it the moment 17 closes, and so the spec for 18 is a paragraph rather than a design pass:

- **Daemon:** `POST /projects`, behind the bearer token, body `{ name, dir, brief? }`. It runs the same `projectReadiness` refusal as the CLI and returns its message verbatim in the 4xx body, then calls `createProject` with the same defaults the CLI uses. No new validation, no new behaviour: the route is the CLI's handler with the flags read from JSON. Acceptance: created row equals the CLI's for the same inputs; a not-ready directory is refused with the CLI's own message; no token needed for nothing.
- **Page:** a `New project` control beside the project selector; a form of name, directory path, optional brief. **The directory is typed or pasted, absolute, no chooser.** A web page cannot open a folder picker that returns a path, and the host can (PowerShell's folder dialog through the same seam as the toast), but that is the late-stage packaging batch, not this one. A refusal shows the daemon's message where the form is; success selects the new project and the scope announcement appears the way the CLI prints it (rule 9, never a silent empty board). Acceptance: DOM-harness tests for create, refuse, and the selector updating without a reload.
- **Not in it:** a folder picker; editing a project's directory; deleting a project; anything the CLI does not already do.

SOFT: the two halves are one engineer session each. If that is wrong the Orchestrator says so at 18's spec.

## 3. What the owner is told now, through the Liaison, in this order

They are at the workstation. They should hear the honest answer from us and not work it out.

1. **To create a project today:** in a terminal, from the project's folder, `magarine project create --name "<name>"`; from anywhere, add `--dir <path>`. The open window picks it up within a few seconds without a reload. If the folder has no `SCOPE.md`, the Manager will start by interviewing you when you first write to it.
2. **To talk to the Manager today:** the tab at the top called `Scope` holds the conversation under the scope document; type in the box at the bottom and press Send. We are renaming that tab `Manager` in this batch because it hid the conversation from you; if you want a different word, say it.
3. **Creating a project inside the window** is the first item of the next batch, with the folder typed as a path rather than picked; a picker comes with the installer later.

One question for them, not a gate: is `Manager` the word they want on the tab?

## 4. Batch 17, unchanged otherwise

Item 4b remains in flight and remains the designated drop. Item 5 follows. The walk in spec section 4 as amended by addendum 1 section 5 is the closing condition, with one addition to the stranger's walk brief: the stranger's task is to create a project in a terminal and then get the Manager to do one small thing, and every point of confusion between the two is recorded in order. That is the evidence that decides whether the label was enough.
