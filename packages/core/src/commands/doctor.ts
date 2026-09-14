import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDaemonFile, type DaemonFileCheck } from '../daemon.ts';
import { probeDaemonHealth } from '../daemonClient.ts';
import { resolveCommand, type ResolvedCommand } from '../process.ts';

// `magarine doctor`: the owner's own first stop when something is wrong.
// Every line is PASS, FAIL, or SKIP with one plain sentence -- no stack
// trace, no error code as the headline -- because the point of this command
// is turning "it failed and I don't know why" into "line three says log in".
// Read-only: nothing here writes ticket/project state, and the login check
// in particular makes no billed call unless `--paid` is passed explicitly
// (see below).
//
// SKIP exists specifically for "this check could not be answered, for a
// reason that is not itself evidence of a problem" -- distinct from both
// PASS and FAIL. A doctor that collapses "I don't know" into "PASS" lies by
// omission the one time it matters most (see the login check below); a
// doctor that collapses it into "FAIL" sends the owner chasing a problem
// that may not exist. Neither is acceptable for the command whose entire
// job is being trustworthy when something else already isn't.

export type DoctorStatus = 'pass' | 'fail' | 'skip';

export interface DoctorLine {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface ProbeResult {
  ok: boolean;
  output: string;
}

export interface DoctorOptions {
  stateDir: string;
  /** Batch 10 (Role Q): an explicit opt-in to also make one real, billed `claude -p` call, proving the tool actually answers end to end. Off by default -- doctor must cost nothing unless asked. */
  paid?: boolean;
  /** Test-only seam: overrides Node's own reported version. Defaults to `process.versions.node`. */
  nodeVersion?: string;
  /** Test-only seam: overrides `resolveCommand` (process.ts) so a test can simulate "found"/"not found"/"needs prefix args" without touching the real PATH. Defaults to the real one. */
  resolveCommandFn?: (name: string) => ResolvedCommand;
  /** Test-only seam: overrides how an external command is actually run (real production behaviour: `spawnSync`). Lets a test script exact PASS/FAIL/JSON responses for `claude --version`, `claude auth status --json`, `pnpm --version`, and (under `--paid`) `claude -p`, without a real binary on PATH. */
  runProbeFn?: (exe: string, args: string[]) => ProbeResult;
  /** Test-only seam: overrides the daemon-file staleness check (daemon.ts/daemonClient.ts). Defaults to the real `checkDaemonFile` + `probeDaemonHealth`. */
  checkDaemonFileFn?: (stateDir: string) => Promise<DaemonFileCheck>;
}

function realRunProbe(exe: string, args: string[]): ProbeResult {
  const result = spawnSync(exe, args, { encoding: 'utf8', shell: false });
  if (result.error) {
    return { ok: false, output: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, output: (result.stderr || result.stdout || `exit code ${result.status}`).trim() };
  }
  return { ok: true, output: result.stdout.trim() };
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorLine[]> {
  const resolveCommandFn = options.resolveCommandFn ?? resolveCommand;
  const runProbe = options.runProbeFn ?? realRunProbe;
  const checkDaemonFileFn = options.checkDaemonFileFn ?? ((stateDir: string) => checkDaemonFile(stateDir, probeDaemonHealth));
  const nodeVersion = options.nodeVersion ?? process.versions.node;

  const lines: DoctorLine[] = [];

  const nodeMajor = Number(nodeVersion.split('.')[0]);
  lines.push({
    name: 'Node.js version',
    status: nodeMajor >= 24 ? 'pass' : 'fail',
    detail:
      nodeMajor >= 24
        ? `${nodeVersion} (>= 24 required)`
        : `${nodeVersion} is too old. Install Node.js 24 or newer from https://nodejs.org/ and try again.`,
  });

  try {
    const pnpm = resolveCommandFn('pnpm');
    const probe = runProbe(pnpm.executable, [...pnpm.prefixArgs, '--version']);
    // Batch 10 owner walk, finding 1 (now fixed at the source):
    // `resolveExecutable` used to pick the first quoted path in pnpm's
    // `.cmd` shim that merely looked like a real executable -- an absent
    // `node.exe` next to it -- even though `pnpm --version` worked
    // perfectly typed into a real terminal. `resolveCommand` (process.ts)
    // now recognises the shim's real shape and returns the script it
    // actually runs, executed through this process's own node; a probe
    // failure here is therefore a genuine FAIL again, not an artifact of
    // our own resolution being wrong. See process.test.ts's synthetic
    // shim fixtures for the regression coverage.
    lines.push({
      name: 'pnpm',
      status: probe.ok ? 'pass' : 'fail',
      detail: probe.ok ? probe.output : `pnpm was found but did not run (${probe.output}). Reinstall it and try again.`,
    });
  } catch {
    lines.push({
      name: 'pnpm',
      status: 'fail',
      detail: 'pnpm was not found on PATH. Install it: https://pnpm.io/installation -- then try again.',
    });
  }

  let claudeCmd: ResolvedCommand | undefined;
  try {
    claudeCmd = resolveCommandFn('claude');
    const probe = runProbe(claudeCmd.executable, [...claudeCmd.prefixArgs, '--version']);
    lines.push({
      name: 'claude CLI',
      status: probe.ok ? 'pass' : 'fail',
      detail: probe.ok
        ? `${probe.output} (${claudeCmd.executable})`
        : `claude was found but did not run (${probe.output}). Reinstall it and try again.`,
    });
  } catch {
    lines.push({
      name: 'claude CLI',
      status: 'fail',
      detail: 'claude was not found on PATH. Install Claude Code, then try again: https://docs.claude.com/claude-code',
    });
  }

  // Zero-cost login check: `claude auth status --json` reports login state
  // as a local account lookup, not a generation, so it never spends
  // anything -- that is why it is used here rather than a real `-p` call
  // (which only ever happens under `--paid` below, on explicit request).
  //
  // This command's exact shape is version-dependent and not something this
  // project controls, so three outcomes are kept distinct rather than
  // forced into PASS/FAIL: the command ran and gave a clear boolean (PASS
  // or FAIL, trusted completely); the command ran but its `loggedIn` field
  // was missing or not a boolean (SKIP -- an unrecognised shape, most likely
  // an older or newer claude build than this was written against); or the
  // command itself failed to run at all (SKIP -- claude may simply be too
  // old to have this subcommand). A doctor that reported PASS here on a
  // shape it did not understand would be worse than one honest about not
  // knowing.
  //
  // Privacy: `claude auth status --json` also returns the owner's email,
  // organisation id/name, subscription type, API provider, and projects
  // directory alongside `loggedIn` (confirmed against a real login). This
  // check reads `loggedIn` and NOTHING else from that object -- no other
  // field is read, stored, or put into a detail string -- and the raw probe
  // output is never echoed on any branch, including the two SKIP branches
  // below, specifically so a "here's what it printed" habit can never turn
  // into the owner's email address ending up in a terminal, a log, or a
  // screenshot pasted back to us. Point them at running the command
  // themselves instead.
  if (claudeCmd) {
    const probe = runProbe(claudeCmd.executable, [...claudeCmd.prefixArgs, 'auth', 'status', '--json']);
    if (!probe.ok) {
      lines.push({
        name: 'claude login',
        status: 'skip',
        detail:
          'could not check login status: `claude auth status --json` did not run. This can happen on an older claude build; run `claude auth status` yourself, or `claude` to log in if you\'re not sure.',
      });
    } else {
      let parsed: { loggedIn?: unknown } | undefined;
      try {
        parsed = JSON.parse(probe.output);
      } catch {
        parsed = undefined;
      }
      if (!parsed || typeof parsed.loggedIn !== 'boolean') {
        lines.push({
          name: 'claude login',
          status: 'skip',
          detail: `\`claude auth status --json\` returned a shape this check doesn't recognise, so login status is unknown (its output can differ by claude version). Run \`claude auth status\` yourself to check.`,
        });
      } else if (parsed.loggedIn) {
        lines.push({ name: 'claude login', status: 'pass', detail: 'logged in' });
      } else {
        lines.push({
          name: 'claude login',
          status: 'fail',
          detail: 'not logged in. Run: claude   (then complete the browser login), and try again.',
        });
      }
    }
  } else {
    lines.push({ name: 'claude login', status: 'skip', detail: 'skipped -- claude is not installed (see the line above).' });
  }

  if (options.paid && claudeCmd) {
    const probe = runProbe(claudeCmd.executable, [...claudeCmd.prefixArgs, '-p', 'say ok', '--output-format', 'json']);
    lines.push({
      name: 'claude live call (--paid)',
      status: probe.ok ? 'pass' : 'fail',
      detail: probe.ok ? 'received a real response from claude -p "say ok"' : `the real call failed: ${probe.output}`,
    });
  }

  try {
    mkdirSync(options.stateDir, { recursive: true });
    const probePath = join(options.stateDir, '.doctor-write-probe');
    writeFileSync(probePath, 'ok');
    rmSync(probePath, { force: true });
    lines.push({ name: 'state directory', status: 'pass', detail: `writable: ${options.stateDir}` });
  } catch (err) {
    lines.push({
      name: 'state directory',
      status: 'fail',
      detail: `cannot write to ${options.stateDir}: ${err instanceof Error ? err.message : String(err)}. Check its permissions, or pass --state-dir to use a different one.`,
    });
  }

  const daemonCheck = await checkDaemonFileFn(options.stateDir);
  if (daemonCheck.status === 'live') {
    lines.push({
      name: 'daemon',
      status: 'pass',
      detail: `running on 127.0.0.1:${daemonCheck.info!.port} (pid ${daemonCheck.info!.pid})`,
    });
  } else {
    lines.push({
      name: 'daemon',
      status: 'pass',
      detail: 'not running -- start one with `magarine serve` when you want tickets to run on their own.',
    });
  }

  return lines;
}

export function formatDoctor(lines: DoctorLine[]): string {
  return lines.map((l) => `${l.status.toUpperCase().padEnd(4)}  ${l.name.padEnd(20)} ${l.detail}`).join('\n');
}

// FAIL is the only status that fails the command -- SKIP means "unknown",
// not "broken", and must never silently escalate to a nonzero exit code
// (see the login check's own header comment for why collapsing "unknown"
// into either PASS or FAIL is the wrong call).
export function doctorExitCode(lines: DoctorLine[]): number {
  return lines.some((l) => l.status === 'fail') ? 1 : 0;
}
