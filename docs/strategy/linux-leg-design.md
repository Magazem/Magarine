# Magarine — Linux leg design note (for the batch that takes it, not for dispatch yet)

Author: Strategist. Date: 2026-09-14. Written on the owner's answer: "i don't have anything on ubuntu but i can boot on it and test what is needed if you prepare me files".
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What I verified

HARD:
- This PC has WSL 2 with a `docker-desktop` distribution (stopped) and Docker 29.5.2 installed. UNKNOWN whether Docker Desktop starts cleanly; the role checks.
- The repository has never been pushed anywhere. Files reach Ubuntu by disk, not by clone.
- The owner will boot into Ubuntu, has nothing installed there, and chose the prepared-script path over running the team on Ubuntu.

## 1. What the Docker finding changes

The one-round-trip constraint was the whole difficulty. With Docker on this PC, the setup script can be built and proven against a bare `ubuntu:24.04` container here, by the team, before the owner reboots once. Everything that does not need a Claude login runs in that container too: the full suite twenty times, the POSIX tree-kill by pid, graceful shutdown by signal, which is the one path Windows could never test, the daemon lifecycle, and the fake-adapter mission loop. The owner's boot is then reduced to two things only a real login can give: the paid three-ticket run and a live cancel of a real worker on Linux, plus real-hardware sanity.

If Docker Desktop does not start, the container leg is skipped and the owner's round trip carries everything; the script design below is the same either way, only less proven.

## 2. The deliverable the owner receives

One directory, copied to a USB stick or read from the Windows partition, containing the repository at a named commit and a `linux-leg/` folder with:

- **`1-setup.sh`**, idempotent, no `sudo` required. Installs to the user's home: Node 24 or newer from the official tarball, pnpm via corepack, the Claude Code tool via its official installer or npm into the user prefix, and checks git is present (git is the one thing that may need `sudo apt install git`; the script says so plainly and stops if it is missing). Every step prints PASS, FAIL, or SKIP with the exact command, the exit code, and one sentence on what to do. The script never asks a question.
- **`2-login.md`**, one page: run `claude` once, complete the browser login, run `claude -p "say ok" --output-format json` to confirm, then go to step 3. This is the only interactive step and it is the owner's alone.
- **`3-run.sh`**, non-interactive, runs in two phases and writes everything to `linux-leg/report/`. Phase A needs no login: versions, suite twenty times, tree-kill by pid, signal-delivery test, daemon lifecycle, fake-adapter mission loop. Phase B needs the login: the three-ticket shared-directory run through the daemon with the Claude adapter, a live cancel from a background shell, the usage of every run. Phase B is skipped with a clear line if the login check fails, and Phase A's results still stand.
- **`4-send-back.md`**: the report folder is packed into one archive; the owner copies it to the Windows partition at a named path or to the USB stick, then tells the Liaison it is there.

The report contains: `uname`, distribution, every version, every command's stdout, stderr and exit code, every test output, pid survivor checks, temp-directory counts before and after, `daemon.json`, board and inbox outputs, and `usage_json` for every run. Complete enough that no second boot is needed to answer an obvious question.

## 3. Owner questions for that batch, non-blocking
1. Can Ubuntu see the Windows drive in the Files app under Other Locations? If yes, the files travel that way; if not, a USB stick.
2. Roughly how much disk is free on the Ubuntu side? Node and the tool together need about one gigabyte in the home directory.

## 4. Role shape
One role, sonnet high, owning `linux-leg/` and `process.ts` for the POSIX path only. Steps: prove Docker Desktop starts or record that it does not; build the scripts against a bare container; run Phase A in the container and commit its report as the first Linux evidence; only then hand the directory to the owner through the Liaison with the two questions above. The Orchestrator reruns the container leg itself before the hand-off.
