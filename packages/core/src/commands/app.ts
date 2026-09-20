import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { checkDaemonFile, type DaemonFileInfo } from '../daemon.ts';
import { daemonRequest, probeDaemonHealth } from '../daemonClient.ts';
import { serve, type ServeOptions } from './serve.ts';

// `magarine app` (batch 17, ruling 30 as amended by
// docs/strategy/batch-17-addendum-1-ruling-30-amended.md): opens the board in
// its own window -- Chromium's application mode, no address bar, no tabs --
// and lives exactly as long as it should:
//
// - OWNED mode (no live daemon for this state directory): the host runs the
//   daemon itself, in this process (`serve()` is a plain function), then opens
//   the window. The host's lifetime is the daemon's. Closing the WINDOW never
//   stops the daemon and never cancels work -- it prints one line saying so.
//   Ctrl+C stops the daemon FIRST, then closes the window.
// - ATTACH mode (a live daemon exists): the host only opens a window against
//   it and lives until the window closes. The daemon is never touched.
//
// The host waits on the CHILD'S EXIT and nothing else: no polling the window
// list, no supervision, no restart. It is a window host, not a supervisor.
//
// THE SECURITY LINE: the token appears in no spawn argument, no stdout, no
// stderr. The window is opened at `#launch=<code>` -- a one-time launch code
// the page trades for the token (daemonApi.ts, ruling 30 item 4); the
// fragment never reaches the server in the GET, and the code is burned by the
// time a process listing could show it. Everything that reaches the outside
// world (spawn, PowerShell, output) goes through the injected `AppSeams`, the
// way token.ts injects the clipboard tool, so tests prove all of this
// without a browser.
//
// Notifications are NOT raised here or in the page (batch 17 addendum 1): a
// live Web Notification makes Edge ignore a graceful close, and this host's
// whole lifecycle rests on the graceful close working.

/** What is spawned: only ever `executable`, fixed flags, and the launch URL -- never the token. */
export interface WindowSpec {
  executable: string;
  args: string[];
}

export interface WindowChild {
  pid: number;
  /** Resolves when the browser process exits, however it exits; `error` is set when it could not be started at all. */
  exited: Promise<{ code: number | null; error?: string }>;
  /** The last resort after a graceful close was asked for and not honoured. */
  kill(): void;
}

export interface AppSeams {
  /** Owned mode: the daemon, in this process. */
  serve: (opts: ServeOptions) => Promise<void>;
  /** The live daemon for this state directory (matching its database), if any. */
  findLiveDaemon: () => Promise<DaemonFileInfo | undefined>;
  /** Reads the token from `daemon.json` (never through `onListening`) and mints a one-time launch code over the API. The token stays inside this seam. */
  mintLaunchCode: () => Promise<string>;
  spawnWindow: (spec: WindowSpec) => WindowChild;
  /** Asks the window to close the way a person does (PowerShell `CloseMainWindow()` on Windows). */
  askWindowClose: (pid: number) => Promise<void>;
  /** Attach mode's Ctrl+C. Returns a disposer. (Owned mode's Ctrl+C is `serve()`'s own.) */
  onInterrupt: (handler: () => void) => () => void;
  /** How many tasks are running right now, for the "window closed" line. */
  countInFlight: () => number;
  /** Output, through cli.ts's `output(flags, ...)` in production. */
  say: (human: string, data?: unknown) => void;
  sayError: (line: string) => void;
  /** Where the executable might be: `exists` and the environment, injected so resolution is testable. */
  exists: (path: string) => boolean;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
}

export interface AppOptions {
  stateDir: string;
  /** `--browser <path>`. */
  browserFlag?: string;
  /** What `serve` was given (flags, adapter, db) for owned mode -- a thunk, evaluated ONLY when the daemon is actually started here, so attach mode never opens a database or resolves an adapter (e.g. `claude`) it does not need. `onListening`/`onStopped` are the host's to compose. */
  serveOptions: () => Omit<ServeOptions, 'onListening' | 'onStopped'>;
  /** Prints the daemon's listening line exactly as `serve` does. */
  onListening: (info: { pid: number; port: number; stateDir: string }) => void;
  onStopped: (info: { cancelled: string[] }) => void;
  /** Graceful-close patience before the kill (spec: 5 s). */
  closeTimeoutMs?: number;
}

// ---- browser resolution --------------------------------------------------

export interface ResolvedBrowser {
  executable: string;
  kind: 'chrome' | 'edge' | 'custom';
  /** Reported on the terminal, the way the test harness reports Chrome's. */
  strategy: string;
}
export type BrowserResolution = { found: ResolvedBrowser } | { none: true; looked: string[] };

/** The order is ONE array: the owner's overrule of "Chrome first" is one line here. */
const BROWSER_ORDER: Array<'chrome' | 'edge'> = ['chrome', 'edge'];

export const EDGE_EXTRA_FLAGS = ['--disable-sync', '--disable-features=msImplicitSignin'];

function candidates(kind: 'chrome' | 'edge', platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  if (platform === 'win32') {
    const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LocalAppData']].filter((r): r is string => Boolean(r));
    const rel = kind === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
    return roots.map((r) => join(r, ...rel));
  }
  if (platform === 'darwin') {
    return kind === 'chrome'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  return kind === 'chrome'
    ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
}

/**
 * `--browser` or `MAGARINE_BROWSER` wins over both, then Chrome, then Edge
 * (amended ruling 30 item 6: the spike found Chrome opens clean where Edge
 * needs two flags to avoid a sign-in interstitial). With none found, says
 * where it looked.
 */
export function resolveWindowBrowser(
  opts: { browserFlag?: string },
  seams: Pick<AppSeams, 'exists' | 'env' | 'platform'>
): BrowserResolution {
  const looked: string[] = [];
  const custom = (path: string, via: string): BrowserResolution => {
    looked.push(path);
    if (!seams.exists(path)) return { none: true, looked };
    const edge = /msedge|microsoft-edge|Microsoft Edge/i.test(basename(path));
    return { found: { executable: path, kind: edge ? 'edge' : 'custom', strategy: `${via}${edge ? ', with sign-in and sync disabled' : ''}` } };
  };
  if (opts.browserFlag) return custom(opts.browserFlag, '--browser');
  const fromEnv = seams.env['MAGARINE_BROWSER'];
  if (fromEnv) return custom(fromEnv, 'MAGARINE_BROWSER');
  for (const kind of BROWSER_ORDER) {
    for (const path of candidates(kind, seams.platform, seams.env)) {
      looked.push(path);
      if (seams.exists(path)) {
        return { found: { executable: path, kind, strategy: kind === 'edge' ? 'edge, with sign-in and sync disabled' : 'chrome' } };
      }
    }
  }
  return { none: true, looked };
}

/** The whole command line for the window. The URL carries the launch CODE; the token is not an input to this function. */
export function windowSpec(browser: ResolvedBrowser, stateDir: string, port: number, code: string): WindowSpec {
  return {
    executable: browser.executable,
    args: [
      `--app=http://127.0.0.1:${port}/#launch=${code}`,
      // A profile of its own is mandatory: without it the URL goes to the
      // owner's running browser and this process exits at once, and the code
      // lands in their history.
      `--user-data-dir=${join(stateDir, 'window')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      '--hide-crash-restore-bubble',
      '--window-size=1400,900',
      ...(browser.kind === 'edge' ? EDGE_EXTRA_FLAGS : []),
    ],
  };
}

// ---- lifecycle -------------------------------------------------------------

const DEFAULT_CLOSE_TIMEOUT_MS = 5000;

/** Ask the window to close like a person would, wait for the exit, and only then kill. */
export async function closeWindowGracefully(child: WindowChild, seams: Pick<AppSeams, 'askWindowClose'>, timeoutMs: number): Promise<'closed' | 'killed'> {
  let exited = false;
  void child.exited.then(() => (exited = true));
  try {
    await seams.askWindowClose(child.pid);
  } catch {
    // Not being able to ask is what the kill below is for.
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([child.exited, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
  if (timer) clearTimeout(timer);
  if (exited) return 'closed';
  child.kill();
  return 'killed';
}

function noBrowserLine(port: number, looked: string[]): string {
  return `no browser found (looked for: ${looked.join(', ') || 'nothing'}) -- open http://127.0.0.1:${port}/ in any browser and run \`magarine token\` to copy the token to paste into its page`;
}

export function windowClosedLine(inFlight: number): string {
  const tasks = inFlight > 0 ? ` (${inFlight} ${inFlight === 1 ? 'task' : 'tasks'} in flight)` : '';
  return `window closed; the daemon is still running${tasks} -- \`magarine app\` reopens the window, Ctrl+C here stops the daemon`;
}

/**
 * Owned mode's window step, run once the daemon is listening. Never throws
 * into `serve()`: a window that cannot open leaves the daemon up.
 */
async function openWindow(
  opts: AppOptions,
  seams: AppSeams,
  browser: ResolvedBrowser,
  port: number
): Promise<WindowChild | undefined> {
  try {
    seams.say(`window: ${browser.strategy} -- ${browser.executable}`);
    const code = await seams.mintLaunchCode();
    return seams.spawnWindow(windowSpec(browser, opts.stateDir, port, code));
  } catch (err) {
    seams.sayError(`could not open the window: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export async function runApp(opts: AppOptions, seams: AppSeams): Promise<void> {
  const resolution = resolveWindowBrowser({ browserFlag: opts.browserFlag }, seams);
  const closeTimeout = opts.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const live = await seams.findLiveDaemon();

  if (live) {
    // ATTACH: never enter serve(), never touch the daemon.
    if (!('found' in resolution)) {
      seams.say(noBrowserLine(live.port, resolution.looked));
      return;
    }
    const child = await openWindow(opts, seams, resolution.found, live.port);
    if (!child) return;
    let interruption: Promise<void> | undefined;
    const dispose = seams.onInterrupt(() => {
      if (interruption) return;
      interruption = closeWindowGracefully(child, seams, closeTimeout).then(() => {
        seams.say(`window closed; the daemon (pid ${live.pid}) started elsewhere keeps running`);
      });
    });
    const result = await child.exited;
    // The window going away because WE closed it: finish saying so first.
    if (interruption) await interruption;
    dispose();
    if (!interruption && result.error) seams.sayError(`could not open the window: ${result.error}`);
    // Closed by the person: exit with no output (the daemon was never ours).
    return;
  }

  // OWNED: the daemon runs in this process, and its lifetime is the host's.
  let child: WindowChild | undefined;
  let daemonDown = false;
  await seams.serve({
    ...opts.serveOptions(),
    onStopped: opts.onStopped,
    onListening: (info) => {
      opts.onListening(info);
      if (!('found' in resolution)) {
        seams.say(noBrowserLine(info.port, resolution.looked));
        return;
      }
      void openWindow(opts, seams, resolution.found, info.port).then((c) => {
        child = c;
        if (!c) return;
        void c.exited.then((r) => {
          if (daemonDown) return; // we closed it ourselves, after the daemon stopped
          if (r.error) seams.sayError(`could not open the window: ${r.error}`);
          else seams.say(windowClosedLine(seams.countInFlight()));
        });
      });
    },
  });
  // serve() returns only after Ctrl+C has stopped the daemon: the window is
  // closed AFTER the daemon, never before.
  daemonDown = true;
  if (child) await closeWindowGracefully(child, seams, closeTimeout);
}

// ---- production seams --------------------------------------------------------

function spawnRealWindow(spec: WindowSpec): WindowChild {
  // stdio ignored: a browser's own output is not ours to relay, and nothing
  // here may put the token (or the code) on a terminal.
  const child: ChildProcess = spawn(spec.executable, spec.args, { stdio: 'ignore' });
  const exited = new Promise<{ code: number | null; error?: string }>((resolve) => {
    child.once('exit', (code) => resolve({ code }));
    child.once('error', (err) => resolve({ code: null, error: err.message }));
  });
  return { pid: child.pid ?? 0, exited, kill: () => void child.kill() };
}

function askRealWindowClose(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve();
    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
      return resolve();
    }
    // Windows: the way a person closes it -- `CloseMainWindow()` -- on the pid
    // this host spawned (an integer, checked above), never a name match.
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).CloseMainWindow() | Out-Null`], {
      stdio: 'ignore',
      windowsHide: true,
    });
    ps.once('exit', () => resolve());
    ps.once('error', () => resolve());
  });
}

export function realAppSeams(deps: {
  findLiveDaemon: () => Promise<DaemonFileInfo | undefined>;
  stateDir: string;
  countInFlight: () => number;
  say: AppSeams['say'];
  sayError: AppSeams['sayError'];
}): AppSeams {
  return {
    serve,
    findLiveDaemon: deps.findLiveDaemon,
    // The token is read from daemon.json exactly the way `magarine token`
    // does, used as a bearer header on one loopback request, and never leaves
    // this function.
    async mintLaunchCode() {
      const check = await checkDaemonFile(deps.stateDir, probeDaemonHealth);
      if (check.status !== 'live' || !check.info) throw new Error('the daemon is not answering, so no launch code could be minted');
      const res = await daemonRequest<{ code?: string }>(check.info, 'POST', '/launch-code', {});
      if (res.status !== 200 || typeof res.body?.code !== 'string') throw new Error(`the daemon refused to mint a launch code (status ${res.status})`);
      return res.body.code;
    },
    spawnWindow: spawnRealWindow,
    askWindowClose: askRealWindowClose,
    onInterrupt(handler) {
      process.on('SIGINT', handler);
      process.on('SIGTERM', handler);
      return () => {
        process.off('SIGINT', handler);
        process.off('SIGTERM', handler);
      };
    },
    countInFlight: deps.countInFlight,
    say: deps.say,
    sayError: deps.sayError,
    exists: existsSync,
    env: process.env,
    platform: process.platform,
  };
}
