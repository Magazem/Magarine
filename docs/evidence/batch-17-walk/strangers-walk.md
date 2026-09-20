# Batch 17 closing walk, part 1: the stranger's walk

Walker: Interface Designer, playing the stranger (never touched the CLI before). Windows 11, Git Bash for the CLI.
Throwaway folder `/tmp/mg-proj-NOnh/my-first-project`, temp `MAGARINE_HOME=/tmp/mg-stranger-d7S2`. `--adapter fake` instead of `claude`
(the only permitted deviation) plus `--no-notify` on `app` so no toast landed on the owner's desktop (a second deviation; disclosed).
`magarine` was already on PATH (a global install, so I skipped the Install section; I did not check that it matches the repo).

**Limit of this walk:** the Windows session was on the lock screen (fingerprint prompt) when `magarine app` opened its window, so I could
not see that window. I drove the same page with a headless Chrome I launched myself (own PID, own profile, killed afterwards) and pasted the
token from `daemon.json`. So the launch-code auto-sign-in was NOT exercised by me; I saw the plain-tab path. Screenshots are in `strangers-walk/`.

## Step 1 - make a folder — matches
`mkdir my-first-project && cd my-first-project` fine.

## Step 2 - project create — matches
```
Created project proj_bbc82b9b-... (My First Project) in C:\Users\yazan\AppData\Local\Temp\mg-proj-NOnh\my-first-project
scope document: ...\SCOPE.md (not found; write it before plan, or the Manager will start by interviewing you)
```
Exactly what step 1 promised. `project list` line: `proj_...  My First Project  model claude-sonnet-5  $0.00 (no cap set)  no tickets  no scope yet`.
Minor: it says `model claude-sonnet-5` on a project I never gave a model, README never mentions a model. Harmless.

## Step 3 - `magarine app --adapter fake --max-parallel 4` — matches, with a gap
```
magarine daemon listening on 127.0.0.1:57585 (pid 10144) -- page: http://127.0.0.1:57585/ -- token: run `magarine token` -- up to 4 workers at once (--max-parallel)
window: chrome -- C:\Program Files\Google\Chrome\Application\chrome.exe
```
Matches the README ("up to 4 workers at once", names the browser). Not stated: the README says to leave the terminal open, but in a tool-driven
shell this needs backgrounding; irrelevant to a human. VERDICT matches.

## Step 4 - `plan --mission "Describe what you want built."` — STRANDED (with fake; see note)
Typed as written. Printed `Created manager ticket tkt_fdb2fe25-... (Describe what you want built.)` exit 0. Five seconds later the inbox says:
```
tkt_fdb2fe25-...	worker_failed_final	proposal must be a JSON object -- magarine retry --ticket tkt_fdb2fe25-..., once the reason above is addressed
```
Board: `FAILED [MANAGER] ... attempts 3/3 cost $0.00 artifacts (3): ...\fake-success.txt`.
The README promises "expect it to come back with only questions"; with the fake adapter it never does, because the fake adapter's reply is a
text file, not a Manager proposal. The advice in the inbox (`magarine retry`) cannot help: retry fails identically. `--fake-script` /
`--fake-outcome` appear in `--help` but no README text or `--help` says what value makes a Manager turn succeed. A stranger cannot get a
Manager reply from `--adapter fake` at all. **Consequence for this task: I could not get the Manager to answer, only to receive.**
Also: `plan --help` prints only "Valid flags" — no description of what `--mission` or `--budget` mean.
This is a fake-adapter limitation, not necessarily a README bug for real users, but it means nobody can rehearse the Manager for free.

## Step 5 - `discuss --message "Target iOS only ..."` — MISLEADS
Printed `Created manager ticket tkt_91b92194-... (Manager: discuss: Target iOS only for now. Go ahead and propose the first…)`, exit 0.
Same failure after 3 attempts. The README says "it reads your scope ... replies"; the CLI never tells you a reply is pending or failed —
success is printed immediately and the failure only shows in `inbox`/`board`. (Same for `plan`.) A stranger types `discuss`, sees
"Created", and has no reply; nothing says "run `magarine inbox` to see the reply". Where does the Manager's reply appear? README does not
say in the CLI; the conversation is only readable in the page. There is no `magarine` command that prints the conversation.

## Step 6 - the window — mostly matches; this is the question you asked
Order of what I saw, honestly recorded, loading the page in a plain tab (no launch code):
1. Landing showed "this page needs the daemon token" plus a password box, text that tells you to run `magarine token` "copies the token to
   your clipboard". `magarine token` in Git Bash printed `no clipboard tool found. Copy it yourself: the "token" field in ...daemon.json` —
   fine and honest. (In PowerShell it would write the owner's clipboard, which the standing rules forbid; I did not try.)
2. After connecting: three tabs across the top, **BOARD / NEEDS YOU 3 / MANAGER**. **I saw MANAGER instantly** — it is in the top bar,
   same size as the other two, and the project name is right next to it (`w2-after-connect.png`). I did not have to hunt.
3. I did NOT click it first, though. The first thing on screen is the Board, and I had to decide to click MANAGER. What happened next:
   clicking it gave a **SCOPE.md panel (mostly empty black box)** above a **CONVERSATION** list and a box "Talk to the Manager — answer a
   question, or ask it to change something." (`w3-manager-tab.png`). Message sent from the box appeared in the conversation as YOU. No reply
   came (see step 4).
   
   **Verdict on the rename: it was enough for someone who reads the tab bar, and a stranger will read the tab bar. The real remaining
   problem is that the Board (default view) and Needs You give no hint that "the way to talk to it is over there".** A Manager turn that
   fails also shows up as a *ticket* on the Board ("Manager: discuss: ...") and in Needs You, which reads as the Manager being a task, and
   never as a conversation, so a person who watches the board could still not know where to type. Also: the conversation box is at the very
   bottom, below a SCOPE panel that takes half the height and holds one line; at 1400x900 the input is barely on screen.
   (The message box also exists in the DOM while the Board tab is showing — the textarea was at y=709 before I clicked MANAGER — so it is
   probably cut off rather than hidden; I did not confirm.)

Other window findings (all real, small):
- **Developer prose is printed to the user in the left rail and Board:** "Identity is generated, not drawn. ... seeded by the worker's model
  tier, derived from BoardTicket.model — or from the project's defaultModel ...", "This is every worker that is actually running. A row is
  a ticket in IN_PROGRESS. The daemon has no roster...", "Every element here names the field it is drawn from, line by line, in
  ui/ELEMENT-FIELD-TABLE.md ...", "Nothing on this page is invented. There are no progress percentages...", and under Activity:
  "worker_progress stays out of this feed ... GET /activity". A stranger has no `ui/` folder and no idea what BoardTicket is. This is text
  written for the team, sitting permanently in the product. It is shown on the Manager tab too (the left rail is always on).
- A failed Manager turn shows raw state names to the user: `WORKER_FAILED_FINAL`, `SONNET`, `dependencies_resolved`, `worker_failed_retryable`.
- Failed-ticket artifacts are shown as `FILE C:\Users\...\fake-success.txt` — long temp paths, the only content of the ticket card.
- Board: three attempts fired and failed within 5 seconds on each Manager turn; nothing on the page says the Manager itself is what failed.

## Step 7 - `ticket add` — not run (out of time; the Manager tab was the assigned question).
## Step 8 - Ctrl+C — not run as written. I stopped the daemon by killing its PID (10144, tree-kill of my own window's PID 17772).
The terminal printed `window closed; the daemon is still running -- ...` even though the tree-kill took the daemon too (harmless, an
artefact of my kill).

## Known and not re-reported
Window cannot create a project; toast click does nothing; sender "Windows PowerShell".

## Summary table
| README step | Verdict |
|---|---|
| 1 folder | matches |
| 2 project create | matches |
| 3 app | matches |
| 4 plan | stranded under `--adapter fake` (no way to get a Manager reply) |
| 5 discuss | misleads (prints "Created", failure only in inbox; no CLI way to read the reply) |
| 6 window | Manager tab found at once; layout/default and leaked developer prose are the issues |
| 7, 8 | not walked |

## Cleanup
Window PID 17772 (and children) closed. Daemon PID 10144 stopped. Headless Chromes (pids 3120, 22788, and later ones; all mine) were killed
by the script. Temp dirs `/tmp/mg-*` and `%TEMP%\mg-cdp` left behind. No git, no clipboard, nothing in `~/.magarine`.
