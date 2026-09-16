# Magarine — Batch 15 addendum 9: `magarine token` puts the token on the clipboard; nothing ever prints it

Author: Strategist. Date: 2026-09-16. Follows addendum 8. Raised by the owner's walk, first step: "i can't find the token". Verified by the Orchestrator in the tree and by me this turn. Lands in batch 15, because the walk is blocked on this step for every next user.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. The contradiction, HARD

- `packages/core/README.md` 417-420: serve prints pid, port and state dir, "**never the token**. The token lives only in `<state dir>/daemon.json`". Lines 484-490 give the reason: a fresh token every start, never logged, never echoed in an error body or a health response.
- `cli.ts` 923-925 does exactly that: the listening line is `magarine daemon listening on 127.0.0.1:<port> (pid <n>)`. No URL, no token.
- `serve.ts` 32: the `onListening` callback is typed to never receive the token.
- Root `README.md` 80: serve "prints the port it's listening on and a token". Line 118-120: "open the page `magarine serve` printed (paste in the token it printed)". Serve prints neither a page address nor a token.
- `ui/index.html` 150: "Paste the token `magarine serve` printed."
- The Orchestrator's walk instructions repeated the README's version without running serve first.

So the product tells a first-time user to paste something it never shows them, and the page's own copy states something untrue. The security rule is right and deliberate. The three documents that contradict it were written from memory of the design, not from the command's output.

## 1. What is fixed and what is not

Fixed, kept as invariants: the token never appears on stdout or stderr, in a log, in a URL, in a response body, or in `--json` output. These are the surfaces that get captured, persisted and shared.

Not an invariant, and never was: that the token cannot reach the owner's own desktop session by a path that is none of those. The owner's terminal scrollback and the owner's clipboard are the same class of surface, the user's own session, and the daemon's token already lives in a file in the user's own profile directory. The Orchestrator's unblock, a clipboard line, was inside the rule.

## 2. Ruling 20 — `magarine token`, and serve names the page

1. **New command `magarine token`.** Reads `<state dir>/daemon.json`, runs `checkDaemonFile` so a stale token is never handed out ("no live daemon for this state directory; start `magarine serve`" on stderr, exit 1), copies the token to the clipboard through the platform's own tool, and prints one line: `token copied to the clipboard; paste it into the page at http://127.0.0.1:<port>/`. The value itself is never written to any stream.
2. **Clipboard tools, no dependencies.** Windows `clip`; macOS `pbcopy`; Linux `wl-copy`, then `xclip -selection clipboard`, then `xsel --clipboard --input`, first found wins. The value goes to the tool's stdin, never as an argument, because arguments are visible in process listings. If no tool is found, the command prints the path of `daemon.json` and the field name `token`, and exits 1. A headless Linux box has no browser on loopback to paste into, so that fallback is the honest answer there.
3. **`--json`** prints `{"copied": true, "port": <n>, "stateDir": "<dir>"}`. Never the token, matching serve.
4. **Serve's listening line gains the page address**, which is not a secret: `magarine daemon listening on 127.0.0.1:<port> (pid <n>) -- page: http://127.0.0.1:<port>/ -- token: run \`magarine token\``. `--json` output is unchanged. This makes the root README's "open the page serve printed" true rather than deleting it.
5. **The page gate** (`ui/index.html` 150) says: "Run `magarine token` in a terminal: it copies the token to your clipboard. Paste it here. It is kept for this tab only and sent as an `Authorization` header to the daemon this page was loaded from, never a cookie, never in a URL." The second sentence is the existing one. If the gate wants a fallback, one clause: "or copy the `token` field from `daemon.json` in the daemon's state directory".
6. **Root README** lines 80 and 118-120 are rewritten to the truth: serve prints the port and the page address; the token comes from `magarine token`. **Core README** documents `token` beside `serve`, and the "never the token" sentence gains: "`magarine token` copies it to your clipboard and is the one sanctioned path; it still never reaches stdout."
7. **SOFT, accepted:** a clipboard manager with history persists the value for as long as the user keeps it. That is the user's own tool in the user's own session, and the token dies with the daemon. Recorded so nobody discovers it later and calls it a leak nobody considered.

## 3. Declined

- **Serve prints the token once to its console.** Serve's stdout is captured by every script, test harness and service wrapper that runs it, and by the Orchestrator's own walks. "Once, only when a TTY" is a branch that reads as safe and is wrong the first time someone pipes it through `tee`.
- **Serve prints a ready-to-open URL carrying the token.** The page's own rule, "never in a URL", exists because URLs go into browser history.
- **The page fetches the token itself.** Any page on loopback could then read it. That is the auth boundary.

## 4. Tests, mutation-checked

- `commands/token.test.ts`: with a live daemon file and an injected copier, the copier receives exactly the token and stdout contains the port and not the token (assert the 64-hex value is absent from stdout and stderr); with a stale or absent daemon file, exit 1, the copier is never called, and no output contains the token; with no clipboard tool found, exit 1 and the output names the file and the field, not the value; `--json` shape exact.
- `cliRouting.test.ts`: `token` is a known command with `--state-dir` and `--json` only.
- `serve.test.ts`: the human listening line contains the page address and not the token.
- A README check already exists for the route table (cad05e5); if it can be extended to assert the root README no longer contains "token it printed", do so, otherwise a grep in the close-out.

## 5. Dispatch

Two tasks, two commits, batch 15. Invariants Engineer, sonnet: `commands/token.ts` and its test, `cli.ts` (routing and the listening line), both READMEs. Designer: the gate sentence in `index.html`, one commit. No file overlap. The owner's walk resumes from its first step once both land; the Orchestrator re-runs step one themselves, from the README, before handing it back.

## 6. Noted, not fixed here

- `magarine status` without `--project` errors with "no such project:" and `doctor` is the only command that shows a running daemon's port. Carry to batch 16: `status` with no project should report the daemon, the port and the page address.
- The process lesson, already a rule in my memory as "estimate against the working tree": owner-facing instructions are written by running each step, not from the design's intent. The walk instructions are the artefact, and they get verified like one.
