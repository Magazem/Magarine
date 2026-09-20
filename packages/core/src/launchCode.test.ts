import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged } from './process.ts';
import { daemonFilePath, type DaemonFileInfo, type DaemonLoop } from './daemon.ts';
import { createRequestHandler } from './daemonApi.ts';
import { openDb } from './db/index.ts';
import { FakeAdapter } from './adapters/fakeAdapter.ts';
import { testTempRoot } from './testSupport.ts';

// Batch 17 Role A item 3 (ruling 30 item 4, docs/strategy/batch-17-spec.md):
// the launch code is how `magarine app` opens the window already signed in
// WITHOUT the token ever being a command-line argument, a URL, a log line or
// terminal output (ruling 20). `POST /launch-code` mints one (behind the
// token); `POST /launch-code/exchange` (unauthenticated -- the page has no
// token yet) answers the token ONCE within sixty seconds. The exchange
// response body is the ONLY place the token appears.

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
const testRoot = testTempRoot('launch-code');
after(testRoot.cleanup);

const TOKEN = 'f'.repeat(16) + '0123456789abcdef'.repeat(3);
const EXPIRED_BODY = { error: 'launch code expired or already used' };

interface Rig {
  base: string;
  advance(ms: number): void;
  mint(auth?: string | null): Promise<{ status: number; text: string; json: any }>;
  exchange(body: unknown): Promise<{ status: number; text: string; json: any }>;
  close(): Promise<void>;
}

async function rig(): Promise<Rig> {
  let clock = 1_000_000;
  const stubLoop: DaemonLoop = {
    live: new Map(),
    stop: async () => ({ cancelled: [] }),
    forceTick: async () => ({ started: [] }),
    cancelTicket: async () => 'not_running',
  };
  const handler = createRequestHandler({
    db: openDb(':memory:'),
    adapter: new FakeAdapter(),
    loop: stubLoop,
    token: TOKEN,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    stateDir: testRoot.root,
    now: () => clock,
  });
  const server: Server = createServer(handler.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, headers: Record<string, string>, body: unknown) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, text, json };
  };
  return {
    base,
    advance: (ms) => { clock += ms; },
    mint: (auth = TOKEN) => call('/launch-code', auth === null ? {} : { Authorization: `Bearer ${auth}` }, {}),
    exchange: (body) => call('/launch-code/exchange', {}, body),
    async close() {
      handler.closeAllStreams();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('mint is refused without the token, or with a wrong one, and mints nothing', async () => {
  const r = await rig();
  try {
    assert.equal((await r.mint(null)).status, 401);
    const wrong = await r.mint('a'.repeat(TOKEN.length));
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.json, { error: 'unauthorized' });
    // Nothing was minted by the refusals: a guessed code does not exchange.
    assert.equal((await r.exchange({ code: 'a'.repeat(64) })).status, 404);
  } finally {
    await r.close();
  }
});

test('mint with the token answers { code, expiresAt }: a 32-byte hex code, sixty seconds ahead, and never the token', async () => {
  const r = await rig();
  try {
    const res = await r.mint();
    assert.equal(res.status, 200);
    assert.match(res.json.code, /^[0-9a-f]{64}$/);
    assert.equal(Date.parse(res.json.expiresAt), 1_000_000 + 60_000);
    assert.ok(!res.text.includes(TOKEN), 'the mint response never carries the token');
    const second = await r.mint();
    assert.notEqual(second.json.code, res.json.code, 'every code is fresh');
  } finally {
    await r.close();
  }
});

test('exchange answers the token exactly once, without any Authorization header, and 404s the second time', async () => {
  const r = await rig();
  try {
    const { code } = (await r.mint()).json;
    const first = await r.exchange({ code });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { token: TOKEN });
    const second = await r.exchange({ code });
    assert.equal(second.status, 404);
    assert.deepEqual(second.json, EXPIRED_BODY);
    assert.ok(!second.text.includes(TOKEN) && !second.text.includes(code), 'the refusal echoes neither the token nor the code');
  } finally {
    await r.close();
  }
});

test('an expired code 404s -- the clock is injected, nothing sleeps', async () => {
  const r = await rig();
  try {
    const almost = (await r.mint()).json.code;
    r.advance(59_999);
    assert.equal((await r.exchange({ code: almost })).status, 200, 'still live one millisecond before its sixty seconds');

    const late = (await r.mint()).json.code;
    r.advance(60_000);
    const res = await r.exchange({ code: late });
    assert.equal(res.status, 404);
    assert.deepEqual(res.json, EXPIRED_BODY);
  } finally {
    await r.close();
  }
});

test('every refusal reads the same: unknown, malformed, missing and non-string codes say nothing about whether a code ever existed', async () => {
  const r = await rig();
  try {
    for (const body of [{ code: 'not-a-real-code' }, {}, { code: 42 }, { code: null }, '{not json', '[]']) {
      const res = await r.exchange(body);
      assert.equal(res.status, 404, JSON.stringify(body));
      assert.deepEqual(res.json, EXPIRED_BODY, JSON.stringify(body));
    }
    const burned = (await r.mint()).json.code;
    await r.exchange({ code: burned });
    const afterBurn = await r.exchange({ code: burned });
    const unknown = await r.exchange({ code: 'b'.repeat(64) });
    assert.equal(afterBurn.text, unknown.text, 'a burned code and a never-minted one are indistinguishable');
  } finally {
    await r.close();
  }
});

test('the cap drops the oldest: after 17 mints the first is gone and the other sixteen still exchange', async () => {
  const r = await rig();
  try {
    const codes: string[] = [];
    for (let i = 0; i < 17; i++) codes.push((await r.mint()).json.code);
    assert.equal((await r.exchange({ code: codes[0]! })).status, 404, 'the oldest was dropped');
    for (const code of codes.slice(1)) assert.equal((await r.exchange({ code })).status, 200);
  } finally {
    await r.close();
  }
});

test('the exchange route is POST-only and the other unauthenticated routes are unchanged (GET /launch-code/exchange is not an exchange)', async () => {
  const r = await rig();
  try {
    const res = await fetch(`${r.base}/launch-code/exchange`);
    assert.equal(res.status, 401, 'a GET falls through to the token check like any data route');
    const data = await fetch(`${r.base}/board?project=x`);
    assert.equal(data.status, 401);
  } finally {
    await r.close();
  }
});

// The item's real point (ruling 20): a REAL daemon process, the REAL token read
// from its own daemon.json, the whole flow -- mint, exchange, a replay, a
// refused mint -- and then the token is looked for on the daemon's stdout and
// stderr. It appears exactly once, in the exchange response body.
test('across a real daemon\'s whole launch-code flow the token appears in the exchange body and NOWHERE on its stdout or stderr', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'grep-'));
  const proc = spawnManaged({ executable: process.execPath, args: [cliPath, 'serve', '--state-dir', stateDir, '--tick-interval', '0.1', '--json'] });
  let stdout = '';
  let stderr = '';
  proc.onStdout((c) => (stdout += c));
  proc.onStderr((c) => (stderr += c));
  try {
    const deadline = Date.now() + 10_000;
    let port = 0;
    while (Date.now() < deadline && !port) {
      const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
      if (line) port = (JSON.parse(line) as { port: number }).port;
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(port, 'serve never printed its listening line');
    const token = (JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo).token;
    assert.match(token, /^[0-9a-f]{64}$/, 'a real token, not a placeholder');
    const post = async (path: string, auth: string | null, body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify(body),
      });
      return { status: res.status, text: await res.text() };
    };

    assert.equal((await post('/launch-code', null, {})).status, 401);
    assert.equal((await post('/launch-code', 'a'.repeat(64), {})).status, 401);
    const minted = await post('/launch-code', token, {});
    assert.equal(minted.status, 200);
    assert.ok(!minted.text.includes(token), 'the mint response does not carry the token');
    const { code } = JSON.parse(minted.text) as { code: string };
    const first = await post('/launch-code/exchange', null, { code });
    assert.equal(first.status, 200);
    assert.equal((JSON.parse(first.text) as { token: string }).token, token, 'the exchange body IS where the token appears -- the positive control that makes the grep below meaningful');
    const replay = await post('/launch-code/exchange', null, { code });
    assert.equal(replay.status, 404);
    assert.ok(!replay.text.includes(token));

    await new Promise((resolve) => setTimeout(resolve, 300)); // let any late output land
    assert.ok(!stdout.includes(token), "the daemon's stdout must never contain the token");
    assert.ok(!stderr.includes(token), "the daemon's stderr must never contain the token");
    assert.ok(!stdout.includes(code) && !stderr.includes(code), 'nor the launch code');
  } finally {
    await proc.stop(200);
    await proc.wait();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
