# Magarine — Batch 19, item 5: the real adapter is the default

Author: lead. Date: 2026-09-23. Tree at `f84d998`. Triggered by the owner's walk.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What happened, HARD

The owner started batch 19's walk and reported: *"immediate fail said message should be in good json
format"*, right after typing to the Manager in the window.

- `cli.ts` 515: `const kind = typeof flags.adapter === 'string' ? flags.adapter : 'fake';`. Every
  command that runs work (`app`, `serve`, `tick`, `run`) uses the **fake** adapter unless
  `--adapter claude` is typed.
- The fake adapter writes a dummy file and no Manager proposal. The Manager ticket then fails with
  *"proposal must be a JSON object"*, three times, and lands in Needs You. Reproduced by the lead on a
  scratch project: FAILED, attempts 3/3, cost $0.00, reason exactly that.
- The same message on the real adapter works: the Manager replied, asked which language and test
  framework, and blocked properly, for $0.17. Reproduced by the lead.
- `README.md` 137 says to run `magarine app --adapter claude`. The owner forgot the flag once and
  the product blamed JSON.

The owner, told this, chose: *"fix that or whatever and continue batching"*. The lead recommended
making the real adapter the default, and rules it here.

## 1. Ruling 41 — the product runs real work by default; the fake is asked for by name

- **Resolution, one function:** `--adapter` if given, else `MAGARINE_ADAPTER` from the environment
  if set, else **`claude`**. The environment variable exists so that a test harness can pin `fake`
  once instead of passing a flag to every spawn. It is named plainly, documented in `--help`, and
  shown by `doctor`.
- **`--fake-script`, `--fake-outcome` and `--fake-progress-gap` without the fake adapter are refused**
  in one sentence naming `--adapter fake`, never silently honoured and never silently ignored.
- **The fake adapter tells the truth about itself.** A Manager-kind ticket run on it, with no script,
  fails ONCE, not retryably, with a reason that says what is actually wrong: this daemon is running
  the fake adapter, which never writes a Manager proposal; start it with `--adapter claude`. It never
  says "JSON".
- `GET /health` carries `adapter: 'claude' | 'fake'`, and `doctor` prints which adapter a daemon
  started now would use and why (flag, environment, or default).
- `README.md` drops `--adapter claude` from its ordinary commands, and says once, where the fake is
  mentioned, that it is for tests.

## 2. The hazard, stated so nobody walks into it

Seventeen test files spawn the CLI without naming an adapter (HARD, grep). Flipping the default
naively makes **the test suite launch the owner's real Claude CLI**, spending their usage and
running for minutes. So:

- Every test spawn of the CLI pins the fake adapter, through `MAGARINE_ADAPTER=fake` in its spawn
  environment or an explicit flag. A test asserts this for every test file that spawns the CLI.
- **The lead's verification puts a `claude` shim first on `PATH` that records any invocation to a
  marker file and exits non-zero, and runs the full suite. The marker must not exist afterwards.** A
  suite that passes while calling the shim is a failed verification, not a pass.
- The one test that proves the default is `claude` resolves the adapter KIND and stops. It never
  starts a run.

## 3. Acceptance

1. With no flag and no environment variable, `app`, `serve`, `tick` and `run` resolve `claude`.
2. `MAGARINE_ADAPTER=fake` resolves `fake`; `--adapter fake` wins over the environment.
3. `--fake-script` without the fake adapter is refused, in one sentence.
4. A Manager ticket on the fake adapter fails once, non-retryably, with the sentence naming the
   fake adapter and `--adapter claude`, and never the word JSON.
5. `/health` and `doctor` report the adapter and where it came from.
6. The full suite passes with the `claude` shim on `PATH`, and the shim's marker file does not exist.
7. Each mutation fails a named test.
