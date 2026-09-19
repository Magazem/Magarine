// A REAL BROWSER, OVER THE DEVTOOLS PROTOCOL. Ruling 26 condition 4.
//
// This is the `.shots/` client promoted into the suite. Those scripts
// (`shoot-cdp.cjs`, `motionproof.cjs`, `keyscroll.cjs`) proved ruling 18's
// animation and the keyboard reach in batch 15, and nothing in the suite could
// say a word about either. Zero dependencies: Chrome is spawned with a remote
// debugging port and driven with Node's own `WebSocket`.
//
// WHAT THE BROWSER HARNESS MAY CLAIM: what a real browser did, on one machine,
// on one run. That is less than a proof for all browsers and much more than
// any source-text assertion can say about a page.
//
// It pairs with src/ui/domHarness.ts, which runs the page's script without a
// browser: that one owns state-to-DOM behaviour, this one owns rendering,
// layout, focus and motion.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { get } from 'node:http';
import { resolveCommand } from '../process.ts';

/** Where Chrome was found, named the way process.ts names a resolution strategy. */
export type ChromeStrategy = 'magarine_chrome_env' | 'path' | 'platform_install_path';

export interface ResolvedChrome {
  executable: string;
  strategy: ChromeStrategy;
}

/**
 * Chrome, resolved the way `claude` is (process.ts's resolveCommand, i.e. PATH),
 * with MAGARINE_CHROME taking precedence.
 *
 * THE THIRD STEP IS A DELIBERATE ADDITION TO RULING 26, not a convenience.
 * The ruling says "resolved as `claude` is", which is PATH. Chrome is NOT on
 * PATH on this machine -- `chrome`, `google-chrome`, `chromium`, `msedge` and
 * `chrome.exe` are all absent; it installs under Program Files. A PATH-only
 * lookup would therefore be a PERMANENT named skip on the one machine the walk
 * runs on, and ruling 26 item 5 says a green suite with this file skipped is
 * not a closing condition. So the platform's usual install location is tried
 * last.
 *
 * AND THE STRATEGY IS REPORTED, the way `claudeCli` reports `resolved via
 * windows_shim_native_exe` for the same reason: when a future machine resolves
 * differently, the record says which path was taken instead of leaving the
 * next person to guess. `null` means genuinely absent, and the caller turns
 * that into ONE named skip.
 */
export function resolveChrome(): ResolvedChrome | null {
  const override = process.env.MAGARINE_CHROME;
  if (override) return existsSync(override) ? { executable: override, strategy: 'magarine_chrome_env' } : null;

  for (const name of ['chrome', 'google-chrome', 'chromium']) {
    try { return { executable: resolveCommand(name).executable, strategy: 'path' }; } catch { /* not on PATH */ }
  }
  const wellKnown = process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
       'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const hit = wellKnown.find((p) => existsSync(p));
  return hit ? { executable: hit, strategy: 'platform_install_path' } : null;
}

export const CHROME_ABSENT_REASON =
  'Chrome was not found. Looked at $MAGARINE_CHROME, then PATH (chrome, google-chrome, chromium), ' +
  'then the platform\'s usual install location. Set MAGARINE_CHROME to run these proofs.';

interface CdpMessage { id?: number; result?: unknown; error?: { message: string } }

export class Cdp {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, (m: CdpMessage) => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data)) as CdpMessage;
      if (m.id !== undefined && this.pending.has(m.id)) { this.pending.get(m.id)!(m); this.pending.delete(m.id); }
    });
  }

  static async attach(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('could not attach to Chrome')));
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result as Record<string, unknown>)));
    });
  }

  /** Evaluates an expression in the page and returns its value. Throws what the page threw. */
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) as
      { result: { value: T }; exceptionDetails?: { text: string } };
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.text} while evaluating ${expression}`);
    return r.result.value;
  }

  close(): void { this.ws.close(); }
}

export interface Browser {
  cdp: Cdp;
  /** Loads the daemon's page and puts the real token where the gate would, then reloads so the page picks it up. */
  openPage(baseUrl: string, token: string, hash?: string): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getJson(port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/**
 * Spawns headless Chrome on its own temp profile. ONLY this process is ever
 * killed, by handle -- never by image name, which would close the owner's own
 * browser windows.
 */
export async function launchBrowser(chromePath: string, profileDir: string): Promise<Browser> {
  const port = 9400 + Math.floor(Math.random() * 500);
  const proc: ChildProcess = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
    '--window-size=1700,1000', 'about:blank',
  ], { stdio: 'ignore' });

  const deadline = Date.now() + 25_000;
  let target: { type: string; webSocketDebuggerUrl: string } | undefined;
  while (Date.now() < deadline && !target) {
    try {
      const list = await getJson(port, '/json/list') as { type: string; webSocketDebuggerUrl: string }[];
      target = list.find((t) => t.type === 'page');
    } catch { /* not listening yet */ }
    if (!target) await sleep(150);
  }
  if (!target) { proc.kill(); throw new Error(`Chrome never exposed a debugging target on port ${port}`); }

  const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  return {
    cdp,
    async openPage(baseUrl, token, hash = '') {
      // The gate exists precisely so a token is not in a URL; the browser puts
      // it in sessionStorage the way the gate's own Connect button does, then
      // the page is loaded again and reads it at start.
      await cdp.send('Page.navigate', { url: baseUrl + '/' });
      await sleep(600);
      await cdp.eval(`sessionStorage.setItem('magarine.token', ${JSON.stringify(token)})`);
      await cdp.send('Page.navigate', { url: baseUrl + '/' + hash });
      await sleep(1800);
    },
    async close() {
      cdp.close();
      proc.kill();
      await sleep(100);
    },
  };
}
