# Spike: Claude Code CLI as a Magarine worker

Role: Claude Code Headless Adapter Spike (Batch 1, Role C).
Environment: Windows 11, Claude Code CLI `2.1.261` (`claude --version`), Node `26.2.0`.
Script: `spikes/claude-cli/run-worker.js`. Raw outputs: `spikes/claude-cli/runs/*` (secrets removed).
Evidence labels: **HARD** = ran it, output pasted. **SOFT** = inferred. **UNKNOWN** = not determined, with what was tried.

All real runs used a disposable workspace under the OS temp dir (`os.tmpdir()`, e.g.
`C:\Users\...\AppData\Local\Temp\magarine-spike-*`), never this repository. The script
refuses a `--workspace` argument that resolves inside the repo.

## 0. A Windows-specific problem that has to be solved before any of this works

**HARD.** Node's `child_process.spawn` cannot run `claude` from a plain array-of-args call
on Windows:

- `spawn('claude.cmd', args, { shell: false })` → `Error: spawn EINVAL`. Windows
  `CreateProcess` cannot execute a `.cmd` batch file directly; only a command
  interpreter can.
- `spawn('claude', args, { shell: true })` (array form) → the `--json-schema` JSON
  argument arrives truncated/corrupted (`Error: --json-schema is not valid JSON: JSON
  Parse error: Expected '}'`), reproducibly, every time. Node's own docs and the
  `DEP0190` deprecation warning explain why: with `shell: true` and an args array, Node
  space-joins the array into one command line with **no per-argument escaping**. Any
  argument containing quotes or braces (our JSON schema does, extensively) gets
  mangled. Routing the same array through `cmd.exe /c` manually reproduces the same
  corruption, because `cmd.exe` re-tokenizes its `/c` payload with its own quoting
  rules, not the target process's argv rules.

**Fix used, verified empirically:** build the full command as one POSIX-quoted string
and run it through Git Bash, which is already present on this machine
(`C:/Program Files/Git/usr/bin/bash.exe`) — the same binary this session's own Bash
tool uses. Verified zero-cost (see §3.1): pointing `HOME`/`USERPROFILE` at an empty
temp dir forces the CLI to fail at the "not logged in" step rather than call the API,
so the schema-corruption question can be tested for free. Through `cmd.exe`, that
probe surfaced the JSON-parse error above. Through Git Bash, it reached the "not
logged in" message intact — proof the schema string survived.

```js
function shQuote(s) { return `'${String(s).replace(/'/g, `'"'"'`)}'`; }
const cmdString = `claude ${cliArgs.map(shQuote).join(' ')}`;
spawn('C:/Program Files/Git/usr/bin/bash.exe', ['-c', cmdString], { cwd: ws, shell: false });
```

**Implication for the daemon:** on Windows, the adapter must not naively
`spawn('claude', args, { shell: true })`. It needs either the Git-Bash relay above, or
an equivalent (write the schema to a temp file and have some wrapper read it — not
tested here since Git Bash already solved it). This is not optional plumbing; it is
the difference between every run failing and every run working.

## 1. Happy path: real run, schema-valid result

**HARD**, three real runs, `spikes/claude-cli/runs/2026-09-12T14-04-*-happy/`.

Command (`--allowedTools` and `--permission-mode` shown; full argv in each run's
`command.txt`):

```
claude -p "<prompt>" --output-format json --json-schema "<schema>" \
  --permission-mode bypassPermissions --allowedTools "Write,Bash"
```

cwd = a fresh `os.tmpdir()/magarine-spike-*` directory. Prompt: create `hello.txt`,
then write `.orchestrator/result.json` matching the schema in
`spikes/claude-cli/result-schema.json` (mirrors the worker result contract in
`technical-architecture-weekend-mvp.md` §"Worker result contract").

Result, run 1 (`summary.json`):

```json
{
  "mode": "happy",
  "exitCode": 0,
  "killedByTimeout": false,
  "durationMs": 17712,
  "workspaceListing": [".orchestrator", "hello.txt"],
  "resultJsonPresent": true
}
```

All three happy-path runs: exit `0`, both files present, `is_error: false`,
`subtype: "success"`. `.orchestrator/result.json` and the `structured_output` field of
the stdout envelope both validated against the schema (`status`, `summary`,
`artifacts`, `checks`, `blockers`, `questions` all present and typed correctly) —
checked by eye against `result-schema.json`; the daemon should run an actual JSON
Schema validator rather than trust this.

Relevant stdout envelope fields (full JSON in `runs/*/stdout.txt`):

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "num_turns": 3,
  "duration_ms": 10373,
  "duration_api_ms": 8700,
  "total_cost_usd": 0.36842225,
  "usage": { "input_tokens": 34, "cache_creation_input_tokens": 16232,
             "cache_read_input_tokens": 44969, "output_tokens": 644,
             "output_tokens_details": { "thinking_tokens": 69 } },
  "result": "{\"status\":\"ready_for_review\", ...}",
  "structured_output": { "status": "ready_for_review", "summary": "...",
                          "artifacts": [{"kind":"file","path":"hello.txt"}],
                          "checks": [], "blockers": [], "questions": [] }
}
```

`structured_output` is the schema-validated object already parsed for you — the
daemon does not need to re-parse `result` (a JSON-encoded string) if it trusts
`structured_output`. Both were consistent in all three runs.

Cost and usage are reported per run in `total_cost_usd` and `usage`; nothing needs
scraping from logs.

## 2. Tool restriction, turn caps, timeout, cancellation

### 2.1 `--allowedTools` did not restrict what the worker did — HARD, unexpected

**HARD**, `spikes/claude-cli/runs/2026-09-12T14-05-12-*-restrict-write/` and
`.../14-05-53-*-restrict-write/`.

Ran the same happy-path prompt with `--allowedTools "Read"` (no `Write`, no `Bash`),
first with `--permission-mode bypassPermissions`, then again with
`--permission-mode auto`. In **both** cases the worker still created `hello.txt` and
`.orchestrator/result.json`, exit `0`, and `"permission_denials":[]` — meaning the CLI
never even recorded an attempted denial; the tool restriction had no observed effect
on the coding tools (Write) in this version/mode combination.

This directly contradicts the naive expectation that `--allowedTools "Read"` would
force the "worker never writes the file" failure mode. It did not. **UNKNOWN**: why —
tried `bypassPermissions` and `auto`; did not try `manual` or `dontAsk` for this
specific comparison before moving to `--disallowedTools` instead (§2.2), which behaved
differently.

**Implication for the daemon:** do not assume `--allowedTools` alone is a security or
containment boundary for what the worker can touch. If tool restriction matters
(e.g. "this worker may only read, never write"), it must be verified per
permission-mode before being relied on, or enforced by a different mechanism (a
restricted workspace directory, `--restricted` mode, filesystem permissions, or a
container).

### 2.2 `--disallowedTools` blocked the direct tool, but the worker routed around it via a subagent — HARD

**HARD**, `spikes/claude-cli/runs/2026-09-12T14-10-05-*-disallow-write/`.

Same prompt, `--permission-mode auto --disallowedTools "Write,Edit,Bash"`. Two
different outcomes were observed across two runs of this configuration:

- A quick standalone probe (not using the schema/full script, console-only, not
  committed) showed `Write,Edit,Bash` disallowed and the worker producing **no
  files at all** (`workspaceListing: []`) — the restriction held.
- The committed run through the full script, same flags, instead show the worker
  **spawning a subagent** (`"subagent_stats":{"spawned":1,...}`) after apparently
  failing to write directly, and the subagent succeeded in creating both
  `hello.txt` and `.orchestrator/result.json`. `num_turns: 12`,
  `total_cost_usd: 1.099`, `duration_api_ms: 74042` — roughly 3x the cost and 8x
  the turns of a happy-path run, and `"permission_denials":[]` throughout (the
  denial, if any, was never surfaced in the top-level result). The workspace also
  contained an unexpected `.playwright-mcp` directory, meaning the worker used
  tooling (an MCP server available in this environment) that had nothing to do
  with the task — a sign it was casting around for any way to complete the write
  once its primary tools were blocked.

**Implication for the daemon:** `--disallowedTools` on the main agent does not
necessarily bind subagents it spawns, and a worker denied its primary tool can
retry via a completely different (and here, unexpected and uninstructed) tool
until it finds one that isn't blocked. Tool restriction is not a hard sandbox
boundary in this CLI. If genuine confinement is required, it needs an OS/filesystem/
container-level boundary around the whole worker process tree, not `--allowedTools`/
`--disallowedTools` alone. This also means "worker never writes the file" as a forced
failure mode via tool restriction is unreliable — it may succeed anyway, just slower
and more expensively, as it did here.

### 2.3 Wall-clock timeout and cancellation on Windows — HARD, cancellation did not work as intended

**HARD**, `spikes/claude-cli/runs/2026-09-12T14-12-15-*-cancel/`.

Prompt: run a shell command that sleeps 120 seconds, then create `done.txt`. Script
timeout: 8000ms (`child.kill('SIGTERM')` fires on the Node-side wrapper process — a
Git Bash process running `claude ...`, per §0 — after 8 seconds).

Observed: `killedByTimeout: true` (the 8s timer did fire and call `.kill()`), but the
run's own reported `duration_ms` was **36703ms** and it produced a complete, valid,
schema-shaped result (`is_error:false`, `subtype:"success"`, `terminal_reason:
"completed"`) — the worker's own harness detected that a 120-second foreground sleep
would be disallowed by its policy, converted it into a background task, and reported
back a `"status":"blocked"` result explaining that `done.txt` would appear once the
detached sleep finished. The script's wall-clock measurement (spawn to close event)
was 49358ms.

**The process was not stopped by the timeout kill.** `child.kill('SIGTERM')` targets
the Git Bash process (§0's relay), not the actual `claude.exe`. On Windows, Git
Bash's `exec` does not replace the bash process image the way POSIX exec does —
MSYS2 spawns the real command as a distinct child OS process and bash supervises it,
relaying signals on a best-effort basis. Killing the bash supervisor here did not
stop the underlying `claude.exe`: it kept running to completion 28+ seconds after the
kill signal was sent, and its full stdout still arrived intact.

Attempting to confirm a literal orphaned process by name (`node|bash|claude|cmd|
conhost|sleep`) via `Get-CimInstance Win32_Process` was **inconclusive** — this
machine already runs an entire AionUi team of Claude Code sessions (this spike
included), so a name-based process filter returns dozens of unrelated, legitimate
`claude.exe`/`node.exe`/`cmd.exe` processes and cannot isolate this run's specific
descendant tree without walking the parent/child chain from the exact spawned PID,
which this script did not implement. **UNKNOWN**: whether an orphaned OS process
specifically from this run persisted after the script exited; what is HARD is that
the process was not stopped promptly by the kill signal and continued working to
completion.

**Implication for the daemon:** do not rely on killing whatever handle
`child_process.spawn` returns on Windows, especially not through an intermediate
shell/relay (needed here to work around the argv-quoting problem in §0). A clean
cancel needs either `taskkill /PID <pid> /T /F` (tree-kill) targeting the actual
worker PID — not tested here — or a design that never needs to force-kill mid-run
(e.g., the worker's own background-task mechanism already self-limits long
foreground commands, so a generous wall-clock timeout combined with
`--max-budget-usd` may be more reliable than assuming a kill signal stops work
immediately).

### 2.4 `--max-turns`

**HARD.** `claude -p --help` (CLI 2.1.261) has no `--max-turns` flag at all — grepped
the full help text (`claude -p --help 2>&1 | grep -i turn`) and found nothing but
unrelated mentions of "each user turn" and "next turn" in other flags' descriptions.
The only run-capping flag that exists is `--max-budget-usd <amount>` (a dollar ceiling
on API spend for the run, print-mode only).

The task specification (and the Batch 1 doc) assumed `--max-turns` exists; it does
not, in this CLI version. This is a real gap for the daemon design, not a missing
spike: **turn-count capping is not available as a CLI flag**; only budget-based
capping is. If a hard turn cap is required, it needs to come from the wall-clock
timeout plus `--max-budget-usd`, or from the daemon watching `num_turns` in
`stream-json` events and killing the process itself (see §4).

## 3. Failure modes forced

### 3.1 Not logged in

**HARD**, `spikes/claude-cli/runs/manual-not-logged-in/`. Forced by pointing `HOME`
and `USERPROFILE` at an empty temp directory (no stored credentials) for the child
process only — the real user session and its stored credentials were never touched.

```
USERPROFILE="<empty temp dir>" HOME="<empty temp dir>" claude -p "say hi" --output-format json
```

stdout (single JSON envelope, exit code **0**):

```json
{"duration_api_ms":0,"total_cost_usd":0,"is_error":true,"num_turns":1,
 "subtype":"success","terminal_reason":"api_error","result":"Not logged in · Please run /login",
 "type":"result","duration_ms":234}
```

Notable: the process exit code is **0** even though `is_error: true`. A worker
supervisor that only checks the process exit code will miss this failure entirely —
it must check `is_error` and/or `subtype`/`terminal_reason` in the parsed JSON
envelope. Zero cost (`total_cost_usd: 0`, no tokens) — the check happens before any
API call.

### 3.2 Invalid `--json-schema`

**HARD**, `spikes/claude-cli/runs/manual-invalid-schema/`.

```
claude -p "say hi" --output-format json --json-schema '{not valid json'
```

stderr, exit code **1**:

```
Error: --json-schema is not valid JSON: JSON Parse error: Expected '}'
```

This is a CLI-level argument validation error (no JSON on stdout at all, plain text
on stderr), before any API call — zero cost. A worker supervisor must special-case
"stdout is empty / not JSON" alongside "stdout parses but `is_error` is true";
`--output-format json` does not guarantee stdout is JSON if the arguments themselves
are malformed.

### 3.3 Worker never writes the result file

**HARD, but not the way intended.** Restricting `--allowedTools` to `Read` did not
stop the worker from writing anyway (§2.1) — worse, `--disallowedTools "Write,Edit,
Bash"` also did not reliably stop it, because the worker routed around the block via
a subagent (§2.2). The one run where the file genuinely never appeared
(`workspaceListing: []`) was a quick unrecorded probe under `--disallowedTools` +
`--permission-mode auto`, not reproduced in the committed run. **Net finding: this
failure mode cannot be forced reliably through tool restriction alone** — it is
non-deterministic in this CLI version depending on whether the worker decides to
retry via a different tool/subagent. A daemon cannot assume "block the Write tool"
guarantees no file appears; it must independently verify `.orchestrator/result.json`
exists and is schema-valid, regardless of what tools were nominally disallowed.

### 3.4 Non-zero exit code

**HARD**, `spikes/claude-cli/runs/manual-invalid-schema/` (§3.2) already demonstrates
this: malformed `--json-schema` produces exit code **1**. That is the only case
observed in this spike where the process exit code itself (as opposed to the `is_error`
field inside a JSON envelope) signals failure — every other forced failure here
(not logged in, tool-restriction bypass, the cancellation run) exited or was left in
a state where the JSON envelope's own fields (`is_error`, `subtype`), not the OS exit
code, carried the failure signal. **Implication:** the daemon should treat "process
exit code" as only one of several failure signals, not the primary one — the
CLI is generally exit-0-and-report-failure-in-JSON rather than exit-nonzero, except
for argv-level validation errors that happen before any session starts.

## 4. `stream-json` progress events — HARD, usable without an LLM

**HARD**, `spikes/claude-cli/runs/2026-09-12T14-15-13-*-stream/`. Required
`--verbose` in addition to `--output-format stream-json` — omitting it fails fast
with `Error: When using --print, --output-format=stream-json requires --verbose`
(exit 1, zero cost, itself a useful cheap validation check).

With `--verbose`, stdout is newline-delimited JSON, one object per line. Observed
`type` values in a single happy-path run (25 lines total): `system` (subtypes
`hook_started`, `hook_response`, `init`, `thinking_tokens`), `assistant` (message
content blocks of type `text`, `tool_use`, or `thinking`), `user` (tool results —
either a plain string or an object like `{stdout, stderr, interrupted, isImage,
noOutputExpected}` depending on the tool), `rate_limit_event`, and a final `result`
line identical in shape to the non-streaming `--output-format json` envelope from §1.

This is directly usable for mechanical activity logging without needing an LLM to
interpret it: `type: "assistant"` + content `tool_use` = worker invoked a tool (the
block includes the tool name and input); `type: "user"` + `tool_use_result` = that
tool's result came back; `type: "system", subtype: "thinking_tokens"` = a periodic
progress ping with an estimated token count and delta, useful as a liveness signal
during long-running turns; `type: "result"` = terminal, same fields as §1. A daemon
can drive a "worker activity" log purely off `type`/`subtype` string matching.

## 5. Per-run overhead (three real runs)

**HARD**, from the three happy-path runs in §1 (all one-file, single-turn-shaped
tasks; `runs/2026-09-12T14-04-*-happy/`):

| run | wall `durationMs` (script) | envelope `duration_ms` | `duration_api_ms` | `total_cost_usd` | `cache_creation_input_tokens` | `output_tokens` |
|---|---|---|---|---|---|---|
| 1 | 17712 | 10188 | 8356 | 0.360 | 15815 | 652 |
| 2 | 17884 | 10012 | 8345 | 0.369 | 16229 | 652 |
| 3 | 18242 | 10373 | 8700 | 0.368 | 16232 | 644 |

Process wall time (spawn to exit, measured by the spike script — includes Node/Git
Bash relay startup from §0) was consistently **~17.7–18.2 seconds** for a trivial
one-file task. The CLI's own `duration_ms` (~10–10.4s) and `duration_api_ms`
(~8.3–8.7s) are smaller because they exclude process/relay startup and teardown
outside the CLI's own timers — **roughly 7.5s of fixed overhead sits outside what the
CLI reports about itself**, which a daemon scheduling many short-lived workers needs
to budget for. Cost was consistent at **~$0.36–0.37 per trivial run**, dominated by
`cache_creation_input_tokens` (~16k, a cold system-prompt/tool-schema cache) rather
than the ~650 output tokens actually produced.

**SOFT**, extrapolated from these three data points plus the more complex disallow-
write and cancel runs (§2.2, §2.3), which cost $1.10 and $0.52 respectively at 12 and
8 turns: cost and duration scale with turn count, not file size — a worker that has
to retry, search for an alternate tool, or get redirected into a background task
costs several times more than the straight-line happy path. Not verified against a
genuinely large or multi-file task; all runs here are small, single-file-shaped.

## 6. Reproducing this

Requires the `claude` CLI on PATH, logged in, and (on Windows) Git Bash at
`C:/Program Files/Git/usr/bin/bash.exe`.

```
node spikes/claude-cli/run-worker.js happy
node spikes/claude-cli/run-worker.js restrict-write --permission-mode auto
node spikes/claude-cli/run-worker.js disallow-write --permission-mode auto
node spikes/claude-cli/run-worker.js cancel --timeout-ms 8000
node spikes/claude-cli/run-worker.js stream
```

Each invocation creates a fresh disposable workspace under the OS temp directory and
writes raw stdout/stderr/summary into `spikes/claude-cli/runs/<timestamp>-<mode>/`.
Nothing is written under `packages/` or elsewhere in this repository. The
not-logged-in and invalid-schema failure modes (§3.1, §3.2) are not scripted modes —
they were run manually (commands shown inline in those sections) and their outputs
are committed under `spikes/claude-cli/runs/manual-*/`.

Costs incurred producing this report (`total_cost_usd` summed from every run's
stdout, `runs/*/stdout.txt`): 3 happy-path runs (~$0.36–0.37 each), 2 restrict-write
runs (~$0.37–0.40 each), 1 stream-json run (~$0.37), 1 disallow-write run (~$1.10,
the subagent detour in §2.2), 1 cancel run (~$0.52), plus one ad-hoc quoting-fix
verification (~$0.55, the direct-bash "say hi" call in §0) — **≈$3.86 in this
document's committed runs, ≈$4.41 including the one-off verification** — all in
Claude usage, across 9 real API-calling invocations. Zero-cost checks (not-logged-in,
invalid-schema, missing `--verbose`, the first broken quoting attempts) fail before
any API call and are not counted.
