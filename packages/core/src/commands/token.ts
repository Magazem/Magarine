import { spawnSync } from 'node:child_process';
import { checkDaemonFile, daemonFilePath, type DaemonFileCheck } from '../daemon.ts';
import { probeDaemonHealth } from '../daemonClient.ts';

// Batch 15 addendum 9, ruling 20: `magarine token` is the ONE sanctioned way
// the token reaches the owner's own session -- copied to the clipboard,
// never printed. The invariant this whole file exists to hold: the token
// never reaches stdout, stderr, a log, a URL, a response body, or `--json`
// output (see cli.ts's handler and this module's own TokenResult, neither of
// which ever carries `.token`). The clipboard is the one exception, and even
// there the value goes on the copy tool's STDIN, never as a command-line
// argument -- arguments are visible in a process listing to every other
// account on the machine, stdin is not.

export class TokenError extends Error {}

export interface TokenResult {
  copied: true;
  port: number;
  stateDir: string;
}

export interface RunClipboardResult {
  ok: boolean;
}

// The seam a test injects to prove the value goes on stdin, never in `args`:
// `args` here is always the fixed, tool-specific flag list from
// `clipboardCandidates` below, never the token itself -- a test double
// records every call and asserts the token is absent from every `args`
// array, present only as `input`. See token.test.ts's
// "passes the value on stdin, never as a command-line argument".
export type RunClipboardTool = (exe: string, args: string[], input: string) => RunClipboardResult;

function realRunClipboardTool(exe: string, args: string[], input: string): RunClipboardResult {
  const result = spawnSync(exe, args, { input, encoding: 'utf8', shell: false });
  return { ok: !result.error && result.status === 0 };
}

// Ruling 20 item 2, verbatim: Windows `clip`; macOS `pbcopy`; Linux
// `wl-copy`, then `xclip -selection clipboard`, then `xsel --clipboard
// --input`, first found wins. No dependency added -- every one of these is
// either a platform built-in (`clip`, `pbcopy`) or a common Linux desktop
// tool this project only ever shells out to, never bundles.
function clipboardCandidates(platform: NodeJS.Platform): Array<{ exe: string; args: string[] }> {
  if (platform === 'win32') return [{ exe: 'clip', args: [] }];
  if (platform === 'darwin') return [{ exe: 'pbcopy', args: [] }];
  return [
    { exe: 'wl-copy', args: [] },
    { exe: 'xclip', args: ['-selection', 'clipboard'] },
    { exe: 'xsel', args: ['--clipboard', '--input'] },
  ];
}

// Exported so a test can inject `runTool` (to prove the stdin-not-argument
// discipline above without a real clipboard tool) and `platform` (to
// exercise the Linux fallback chain on any dev machine, not just Linux).
// Production callers (runToken below) use both real defaults.
export function copyToClipboard(
  value: string,
  runTool: RunClipboardTool = realRunClipboardTool,
  platform: NodeJS.Platform = process.platform
): boolean {
  for (const candidate of clipboardCandidates(platform)) {
    if (runTool(candidate.exe, candidate.args, value).ok) return true;
  }
  return false;
}

export interface TokenOptions {
  stateDir: string;
  /** Test-only seam: overrides the daemon-file staleness check. Defaults to the real `checkDaemonFile` + `probeDaemonHealth`, same pairing doctor.ts uses. */
  checkDaemonFileFn?: (stateDir: string) => Promise<DaemonFileCheck>;
  /** Test-only seam: overrides the clipboard copy itself. Defaults to the real `copyToClipboard`. Returns whether a tool was found and the copy attempted; never echoes the value back. */
  copyFn?: (value: string) => boolean;
}

// Reads `daemon.json` (via checkDaemonFile, so a stale file -- dead pid or a
// failed health check -- is never treated as live) and, only for a genuinely
// live daemon, copies its token to the clipboard. `copyFn` is never called
// for a stale or absent daemon: a token that outlives its daemon (or belongs
// to no daemon at all) must never be handed out at all, the same rule
// `removeDaemonFile` (daemon.ts) already enforces on the write side.
export async function runToken(options: TokenOptions): Promise<TokenResult> {
  const checkDaemonFileFn =
    options.checkDaemonFileFn ?? ((stateDir: string) => checkDaemonFile(stateDir, probeDaemonHealth));
  const copyFn = options.copyFn ?? ((value: string) => copyToClipboard(value));

  const check = await checkDaemonFileFn(options.stateDir);
  if (check.status !== 'live') {
    throw new TokenError('no live daemon for this state directory; start `magarine serve`');
  }

  if (!copyFn(check.info!.token)) {
    throw new TokenError(
      `no clipboard tool found. Copy it yourself: the "token" field in ${daemonFilePath(options.stateDir)}`
    );
  }

  return { copied: true, port: check.info!.port, stateDir: options.stateDir };
}
