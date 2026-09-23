// A TINY DOM, SO THE PAGE CAN BE TESTED BY RUNNING IT.
//
// WHY THIS EXISTS. Every other test under src/ui/ asserts on the TEXT of
// index.html, app.js or the stylesheets. Those tests prove the files have a
// shape; they cannot prove the shape does anything. Batch 15 closed on exactly
// that lesson twice over: `app.js` read `ticket.latest_activity` while the
// daemon sent `latestActivity`, and the skin lost the rule that draws
// `aria-current`, and BOTH survived a green suite because nothing ever
// executed the page. Batch 16 items 1 and 2 are behaviour -- a list that
// changes under a selection, a banner that picks a fix from a cause -- so they
// are tested by running the real `ui/app.js`.
//
// WHY IT IS HAND-ROLLED. `package.json` carries no dependencies and the page
// is written under the vanilla rule; adding jsdom to test it would be the
// first dependency in the repo. The surface app.js actually touches is small.
//
// THE TWO RULES THAT KEEP IT HONEST, because a hand-written DOM that is
// written to match the page will agree with the page's mistakes -- which is
// precisely how the `.shots/` stub hid a real defect through eleven
// screenshots:
//
//   1. IT DISCOVERS ITS ELEMENTS FROM THE REAL ui/index.html. Nothing here
//      invents an id. Rename or drop an id in the shipped page and
//      getElementById returns null, exactly as a browser would, and the test
//      that needed it fails.
//   2. IT THROWS ON ANYTHING IT DOES NOT IMPLEMENT. Every unsupported selector,
//      property or API raises rather than returning a plausible value. A shim
//      that quietly answers "" or null is a fixture agreeing with itself.
//
// RULING 26 CONDITION 3: THERE ARE NO FIXTURES. This harness does not answer
// the page's fetches. Its `fetch` is NODE'S OWN, pointed at a real `magarine
// serve` spawned by the test (src/ui/testDaemon.ts), exactly as
// daemonApi.test.ts does. The daemon is the fixture. A hand-written fixture
// cannot contradict the page it was written from -- that is precisely how the
// `.shots` stub sent `latest_activity` and agreed with the page's bug through
// eleven screenshots.
//
// WHAT THIS HARNESS MAY CLAIM: the script's state-to-DOM behaviour under real
// daemon responses.
//
// WHAT IT MAY NOT CLAIM, and does not: rendering, layout, focus, motion,
// contrast, and the live stream. It has no layout or styling, no focus model,
// and no font interface -- app.js has a real branch for a browser without one
// and takes it here. Node has no EventSource either, so the page takes its own
// "stream unavailable, polling" branch: a real branch, exercised honestly, but
// the stream itself belongs to src/ui/browser.test.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { UI_DIR } from './page.ts';

const unsupported = (what: string): never => {
  throw new Error(`domHarness: ${what} is not implemented. Implement it or assert something else -- ` +
    'a shim that answers plausibly is worse than one that stops.');
};

class TextNode {
  data: string;
  parentNode: FakeElement | null = null;
  constructor(data: string) { this.data = data; }
  get textContent(): string { return this.data; }
}

type Node = FakeElement | TextNode;

class FakeElement {
  tagName: string;
  childNodes: Node[] = [];
  parentNode: FakeElement | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, ((e: unknown) => void)[]>();
  ownerDoc: FakeDocument;
  // Plain properties app.js sets directly. Kept as fields, like the DOM.
  value = '';
  type = '';
  title = '';
  placeholder = '';
  step = '';
  rows = 0;

  constructor(tagName: string, doc: FakeDocument) { this.tagName = tagName.toUpperCase(); this.ownerDoc = doc; }

  get id(): string { return this.attributes.get('id') ?? ''; }
  set id(v: string) { this.attributes.set('id', v); }
  get className(): string { return this.attributes.get('class') ?? ''; }
  set className(v: string) { this.attributes.set('class', v); }
  get hidden(): boolean { return this.attributes.get('hidden') === ''; }
  set hidden(v: boolean) { if (v) this.attributes.set('hidden', ''); else this.attributes.delete('hidden'); }
  get children(): FakeElement[] { return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement); }
  get firstChild(): Node | null { return this.childNodes[0] ?? null; }
  // reconcileList walks its kept rows with this. Until batch 19's roster no
  // test rebuilt one row while keeping the next, so it was never reached --
  // and a missing getter answers `undefined`, which is exactly the plausible
  // non-answer rule 2 forbids.
  get nextSibling(): Node | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get offsetWidth(): number { return 0; }          // read only to force a reflow

  get textContent(): string { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v: string) {
    this.childNodes = [];
    if (v !== '') this.appendChild(this.ownerDoc.createTextNode(v));
  }

  appendChild(child: Node): Node {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child: Node): Node {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error('domHarness: removeChild on a node that is not a child');
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  insertBefore(child: Node, ref: Node | null): Node {
    if (ref === null) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = this.childNodes.indexOf(ref);
    if (i < 0) throw new Error('domHarness: insertBefore with a reference that is not a child');
    child.parentNode = this;
    this.childNodes.splice(i, 0, child);
    return child;
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.has(name) ? this.attributes.get(name)! : null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(fn);
  }
  /** Test-side: fire the handlers app.js registered. Not a real event model -- no bubbling, no default action. */
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ target: this, ...event });
  }
  click(): void { this.dispatch('click'); }
  focus(): void { this.ownerDoc.activeElement = this; }
  matches(sel: string): boolean { return matchesSimple(this, sel); }
  closest(sel: string): FakeElement | null {
    let n: FakeElement | null = this;
    while (n) { if (matchesSimple(n, sel)) return n; n = n.parentNode; }
    return null;
  }
  querySelector(sel: string): FakeElement | null { return queryAll(this, sel)[0] ?? null; }
  querySelectorAll(sel: string): FakeElement[] { return queryAll(this, sel); }
  getAnimations(): unknown[] { return []; }        // no animation model; motion is proven in Chrome
  get style(): never { return unsupported('element.style'); }
  get classList(): never { return unsupported('element.classList'); }
}

// Selector support is deliberately narrow: a descendant chain of compounds,
// each `tag`, `#id`, `[attr]` or `[attr="value"]`, in any combination.
// Anything else throws rather than silently matching nothing.
function parseCompound(part: string): { tag?: string; id?: string; attrs: [string, string | null][] } {
  const out: { tag?: string; id?: string; attrs: [string, string | null][] } = { attrs: [] };
  let rest = part;
  const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest);
  if (tag) { out.tag = tag[0].toUpperCase(); rest = rest.slice(tag[0].length); }
  for (;;) {
    if (rest === '') break;
    const idm = /^#([A-Za-z0-9_-]+)/.exec(rest);
    if (idm) { out.id = idm[1]; rest = rest.slice(idm[0].length); continue; }
    const attr = /^\[([a-zA-Z-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/.exec(rest);
    if (attr) { out.attrs.push([attr[1], attr[2] ?? attr[3] ?? null]); rest = rest.slice(attr[0].length); continue; }
    return unsupported(`selector "${part}"`);
  }
  return out;
}

function matchesSimple(el: FakeElement, sel: string): boolean {
  if (sel.includes(',')) return unsupported(`selector list "${sel}"`);
  const parts = sel.trim().split(/\s+/);
  if (parts.length !== 1) return unsupported(`descendant selector "${sel}" used where one compound is expected`);
  const c = parseCompound(parts[0]);
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const [name, value] of c.attrs) {
    if (!el.attributes.has(name)) return false;
    if (value !== null && el.attributes.get(name) !== value) return false;
  }
  return true;
}

function descendants(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  for (const child of root.children) { out.push(child, ...descendants(child)); }
  return out;
}

function queryAll(root: FakeElement, sel: string): FakeElement[] {
  if (sel.includes(',')) return unsupported(`selector list "${sel}"`);
  const parts = sel.trim().split(/\s+/);
  let current = descendants(root);
  parts.forEach((part, i) => {
    const matched = current.filter((el) => matchesSimple(el, part));
    current = i === parts.length - 1 ? matched : matched.flatMap((el) => descendants(el));
  });
  return current;
}

class FakeDocument {
  documentElement: FakeElement;
  body: FakeElement;
  readyState = 'complete';
  activeElement: FakeElement | null = null;
  listeners = new Map<string, ((e: unknown) => void)[]>();
  constructor() {
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag: string): FakeElement { return new FakeElement(tag, this); }
  createTextNode(text: string): TextNode { return new TextNode(text); }
  getElementById(id: string): FakeElement | null {
    return descendants(this.documentElement).find((el) => el.id === id) ?? null;
  }
  querySelector(sel: string): FakeElement | null { return queryAll(this.documentElement, sel)[0] ?? null; }
  querySelectorAll(sel: string): FakeElement[] { return queryAll(this.documentElement, sel); }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(fn);
  }
  get fonts(): undefined { return undefined; }     // app.js has a real branch for this and takes it
}

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

export interface PageOptions {
  /** The daemon's origin, e.g. http://127.0.0.1:53078. Relative paths resolve against it, as in a browser. */
  baseUrl: string;
  /** The real daemon token; seeded into sessionStorage, as the gate would. Pass null to open the page signed out. */
  token?: string | null;
  /** The fragment the page loads with, e.g. `#launch=<code>`. Default: none. */
  hash?: string;
  /** See pageFetch: changes a real JSON response before the page reads it. Off unless a test names it. */
  rewriteJson?: (path: string, body: any) => unknown;
  /** See pageFetch: a route the real daemon never fails, answered with this status and `{ error }` instead. Off unless a test names it. */
  refuse?: { path: string; status: number; error: string };
  /** See pageFetch: holds the daemon's real answer to one method on one path for `ms` before the page sees it. Off unless a test names it. */
  delay?: { path: string; method: string; ms: number };
}

export interface Page {
  document: FakeDocument;
  window: Record<string, unknown>;
  /** Every value the page read from location.hash, in order: what proves the launch code was consumed before the router looked. */
  hashReads: string[];
  /** The current fragment. The page's history.replaceState writes it, as a browser's would. */
  hash(): string;
  /** Every path fetch() was called with, in order. */
  requests: string[];
  /** Run the page's OWN four-second poll callback once, then wait for it to settle. */
  poll(): Promise<void>;
  /** Wait until `check` is true, or fail with `message`. Real I/O needs a real wait. */
  waitFor(check: () => boolean, message: string, timeoutMs?: number): Promise<void>;
  /** Drain the page's in-flight work. */
  settle(): Promise<void>;
  byId(id: string): FakeElement;
  text(id: string): string;
}

/**
 * Loads the REAL ui/index.html's element ids into a tiny document and runs the
 * REAL organism.js, fontCoverage.js and app.js against it. Every fetch the page
 * makes goes over the network to the daemon at `opts.baseUrl`.
 */
export function openPage(opts: PageOptions): Page {
  const doc = new FakeDocument();
  const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8');

  // THE ELEMENTS COME FROM THE SHIPPED PAGE. Every `id="..."` in index.html,
  // in document order, with its real tag name. Nesting is not modelled: every
  // element hangs off <body>, which is enough for a page whose script
  // addresses everything by id -- and any test that needed real nesting would
  // be asserting layout, which belongs in a browser.
  const body = html.slice(html.indexOf('<body>'));
  for (const m of body.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const el = doc.createElement(m[1]);
    el.setAttribute('id', m[2]);
    const cls = /\bclass="([^"]*)"/.exec(m[0]);
    if (cls) el.className = cls[1];
    const hidden = /\bhidden(?=[\s>])/.test(m[0]);
    if (hidden) el.hidden = true;
    for (const a of m[0].matchAll(/\b(data-[a-z-]+|aria-[a-z]+|type|placeholder)="([^"]*)"/g)) el.setAttribute(a[1], a[2]);
    doc.body.appendChild(el);
  }

  // The root's two switches, as the shipped markup declares them.
  for (const a of (/<html([^>]*)>/.exec(html)?.[1] ?? '').matchAll(/\b([a-z-]+)="([^"]*)"/g)) {
    doc.documentElement.setAttribute(a[1], a[2]);
  }

  let currentHash = opts.hash ?? '';
  const hashReads: string[] = [];
  const requests: string[] = [];
  const inFlight = new Set<Promise<unknown>>();
  const polls: (() => void)[] = [];

  // NODE'S OWN fetch, against the real daemon. The only thing added is what a
  // browser does for free: a relative path is resolved against the page's
  // origin. Nothing here inspects, shapes or answers a response.
  //
  // ONE OPT-IN EXCEPTION, `opts.rewriteJson`: for a state the real daemon
  // cannot be made to produce over the wire (`slots.cap: null` is only ever
  // sent to the offline CLI). The test that passes it says so by name; the
  // response is still the daemon's, with only the named field changed.
  //
  // AND ONE MORE, `opts.refuse` (batch 19): a read the real daemon cannot be
  // made to fail -- `GET /models` is a constant list -- answered with a named
  // status and error sentence instead, so the page's own failure branch runs.
  // The request still goes to the daemon; only its answer is replaced.
  const pageFetch = (path: string, init?: RequestInit) => {
    requests.push(path);
    let p: Promise<Response> = fetch(new URL(path, opts.baseUrl), init);
    // And `opts.delay` (batch 19): the daemon's real answer, held back, so a
    // test can make one response land after another -- the order a slow disk
    // or a busy daemon produces, which loopback never does by itself.
    const delay = opts.delay;
    if (delay && path.split('?')[0] === delay.path && (init?.method ?? 'GET') === delay.method) {
      p = p.then((res) => new Promise<Response>((r) => setTimeout(() => r(res), delay.ms)));
    }
    const refuse = opts.refuse;
    if (refuse && path.split('?')[0] === refuse.path) {
      p = p.then(() => new Response(JSON.stringify({ error: refuse.error }),
        { status: refuse.status, headers: { 'Content-Type': 'application/json' } }));
    }
    const rewrite = opts.rewriteJson;
    if (rewrite) {
      p = p.then(async (res) => {
        if (!res.headers.get('content-type')?.includes('json')) return res;
        const body = rewrite(path.split('?')[0], await res.json());
        return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
      });
    }
    inFlight.add(p);
    void p.catch(() => undefined).finally(() => inFlight.delete(p));
    return p;
  };

  const win: Record<string, unknown> = {
    fetch: pageFetch,
    sessionStorage: fakeStorage(),
    localStorage: fakeStorage(),
    location: {
      get hash() { hashReads.push(currentHash); return currentHash; },
    },
    history: {
      // Only a fragment-only URL is modelled, which is the only kind the page passes.
      replaceState: (_s: unknown, _t: string, url: string) => {
        if (!url.startsWith('#')) throw new Error(`domHarness: history.replaceState(${url}) is not implemented`);
        currentHash = url;
      },
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 0)),
    setInterval: (fn: () => void) => { polls.push(fn); return polls.length; },
    addEventListener: () => undefined,
    ReadableStream: undefined,                 // app.js says so, in words, rather than pretending
  };
  if (opts.token !== null && opts.token !== undefined) {
    (win.sessionStorage as ReturnType<typeof fakeStorage>).setItem('magarine.token', opts.token);
  }

  const sandbox: Record<string, unknown> = {
    window: win, document: doc, fetch: pageFetch,
    Promise, Math, JSON, Object, Array, String, Number, Boolean, Date, RegExp, Error, isNaN, parseInt, parseFloat,
    console, setTimeout, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  const ctx = createContext(sandbox);

  for (const file of ['organism.js', 'fontCoverage.js', 'app.js']) {
    runInContext(readFileSync(join(UI_DIR, file), 'utf8'), ctx, { filename: file });
  }

  const byId = (id: string): FakeElement => {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`domHarness: no #${id} in the page -- index.html no longer carries that id`);
    return el;
  };

  return {
    document: doc,
    window: win,
    hashReads,
    hash: () => currentHash,
    requests,
    async settle() {
      // Real network round trips, so this drains what is actually outstanding
      // rather than counting microtasks: wait for every in-flight request, let
      // the handlers that follow it run, and repeat until nothing is left.
      for (let i = 0; i < 40 && inFlight.size > 0; i++) {
        await Promise.allSettled([...inFlight]);
        await new Promise((r) => setTimeout(r, 5));
      }
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
    async waitFor(check, message, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (check()) return;
        if (Date.now() > deadline) throw new Error(`domHarness: timed out after ${timeoutMs}ms waiting for ${message}`);
        await new Promise((r) => setTimeout(r, 25));
        await this.settle();
      }
    },
    async poll() {
      if (!polls.length) throw new Error("domHarness: the page registered no poll interval");
      for (const fn of polls) fn();
      await this.settle();
    },
    byId,
    text: (id: string) => byId(id).textContent,
  };
}
