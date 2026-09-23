// DELIVERABLE 4, AGAINST THE DAEMON THAT ACTUALLY EXISTS.
//
// Until now only the REFUSED branch of the page's event stream was ever
// exercised: `GET /events` did not exist, so every test could prove was that
// the page says "polling" when it cannot connect. That is the easy half. This
// file spawns the REAL `magarine serve`, with a REAL fake-scripted worker that
// leaves a ticket IN_PROGRESS emitting REAL worker_progress events, and reads
// the REAL stream over a real loopback connection.
//
// WHAT IT IS FOR. Every assertion below is an assumption `packages/core/ui/
// app.js` makes about the wire, stated against the wire itself. A page that
// reads a field the daemon does not send fails silently and looks fine --
// which is precisely how both defects this file found survived a fixture, a
// screenshot matrix and a green suite: the throwaway stub in `.shots/` was
// written to match the PAGE, so it agreed with the page's mistakes and
// rendered a "doing" line no real daemon would ever produce.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged, type ManagedProcess } from '../process.ts';
import { daemonFilePath, type DaemonFileInfo } from '../daemon.ts';
import { deriveTestCliCwd, testTempRoot, pinnedFakeEnv } from '../testSupport.ts';
import { UI_DIR } from './page.ts';

const APP = readFileSync(join(UI_DIR, 'app.js'), 'utf8');
const cliPath = fileURLToPath(new URL('../cli.ts', import.meta.url));
const testRoot = testTempRoot('ui-stream');
after(testRoot.cleanup);

interface ServeHandle {
  proc: ManagedProcess;
  waitForListening(): Promise<{ port: number }>;
  kill(): Promise<void>;
}

function spawnServe(args: string[]): ServeHandle {
  const proc = spawnManaged({ env: pinnedFakeEnv(), executable: process.execPath, args: [cliPath, 'serve', ...args] });
  let stdout = '';
  let stderr = '';
  proc.onStdout((c) => (stdout += c));
  proc.onStderr((c) => (stderr += c));
  return {
    proc,
    async waitForListening() {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
        if (line) {
          try {
            return JSON.parse(line) as { port: number };
          } catch { /* still buffering */ }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`serve never listened. stdout=${stdout} stderr=${stderr}`);
    },
    async kill() {
      await proc.stop(200);
      await proc.wait();
    },
  };
}

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawnManaged({ env: pinnedFakeEnv(), executable: process.execPath, args: [cliPath, ...args], cwd: deriveTestCliCwd(args) });
    let stdout = '';
    p.onStdout((c) => (stdout += c));
    p.wait().then(() => resolve(stdout));
  });
}

// A real daemon, a real project, and a real ticket whose worker reports
// progress forever without finishing -- so it stays IN_PROGRESS with real
// worker_progress rows behind it, which is exactly the state the live path
// exists to render.
async function withLiveDaemon(
  body: (ctx: { port: number; token: string; projectId: string; ticketId: string }) => Promise<void>,
): Promise<void> {
  const stateDir = mkdtempSync(join(testRoot.root, 'stream-'));
  const project = JSON.parse(await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']));
  const ticket = JSON.parse(
    await runCli(['ticket', 'add', '--project', project.id, '--title', 'chatty', '--state-dir', stateDir, '--json']),
  );
  const handle = spawnServe([
    '--state-dir', stateDir, '--tick-interval', '0.1', '--json', '--fake-script', `${ticket.id}=progress`,
  ]);
  try {
    const info = await handle.waitForListening();
    const token = (JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo).token;
    await body({ port: info.port, token, projectId: project.id, ticketId: ticket.id });
  } finally {
    await handle.kill();
  }
}

function get(port: number, token: string, path: string): Promise<{ status: number; json: unknown }> {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    .then(async (r) => ({ status: r.status, json: r.status === 200 ? await r.json() : null }));
}

// Reads the stream the way app.js reads it: a streaming fetch (EventSource
// cannot carry an Authorization header and the token must never go in a URL),
// frames split on a blank line, ':' comment lines ignored.
async function readFrames(
  port: number, token: string, since: number, want: number, timeoutMs: number,
): Promise<{ name: string; id: string | null; data: Record<string, unknown> }[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const frames: { name: string; id: string | null; data: Record<string, unknown> }[] = [];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/events?since=${since}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    assert.equal(res.status, 200, 'the stream was refused');
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (frames.length < want) {
      const r = await reader.read();
      if (r.done) break;
      buffer += decoder.decode(r.value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop()!;
      for (const frame of chunks) {
        let name = 'message';
        let id: string | null = null;
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.charAt(0) === ':') continue;                       // the keep-alive comment
          if (line.indexOf('event:') === 0) name = line.slice(6).trim();
          else if (line.indexOf('id:') === 0) id = line.slice(3).trim();
          else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        frames.push({ name, id, data: JSON.parse(dataLines.join('\n')) });
      }
    }
    await reader.cancel().catch(() => {});
  } catch (err) {
    // The deadline firing is how this returns when the daemon simply has
    // fewer frames to send than `want`; that is a fact about the run, not a
    // failure, and the assertions below judge what did arrive.
    if (!ctrl.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
  }
  return frames;
}

// --------------------------------------------------------------------------

test('the daemon frames events exactly the way the page parses them', async () => {
  await withLiveDaemon(async ({ port, token }) => {
    const frames = await readFrames(port, token, 0, 3, 20_000);
    // How MANY frames a run produces is the fake worker's business, not this
    // test's claim; what matters is that every frame that does arrive is
    // shaped the way the page's parser needs.
    assert.ok(frames.length >= 1, `no frame at all arrived on the real stream in 20s`);
    for (const f of frames) {
      assert.ok(f.name && f.name !== 'message', 'a frame carried no event: name, so the page cannot route it');
      assert.ok(f.id && Number.isFinite(Number(f.id)),
        'a frame carried no numeric id:, so the page cannot advance its ?since= cursor');
      assert.equal(typeof f.data, 'object');
      assert.ok('sequence' in f.data && 'eventType' in f.data && 'entityId' in f.data,
        'the data payload is not the event row the page expects');
    }
  });
});

test('ruling 18: the board marker and the stream frame are the same event, not two approximations', async () => {
  // REPLACES two tests that ruling 18 retired. One asserted the frame's
  // entityId named a ticket; it never could -- progress is recorded against
  // the RUN -- and proving that against this real daemon is what got the old
  // path replaced. The other asserted the page animates on the frame's
  // payload.state, which stopped being true when the page stopped reading the
  // frame at all.
  //
  // What the page now depends on is ONE claim, and this is it: the board's
  // latestActivity.sequence IS the events.sequence the stream carries as `id`,
  // and latestActivity.state IS that frame's payload.state. If either drifted,
  // syncMotion would compare against the wrong integer or animate the wrong
  // state, and every source-text test in skin.test.ts would still pass.
  await withLiveDaemon(async ({ port, token, projectId, ticketId }) => {
    let marker: { sequence: number; state: string } | null = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !marker) {
      const board = (await get(port, token, `/board?project=${projectId}`)).json as {
        tickets: Array<{ id: string; latestActivity: { sequence: number; state: string } | null }>;
      } | null;
      marker = board?.tickets.find((t) => t.id === ticketId)?.latestActivity ?? null;
      if (!marker) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(marker, 'the board never reported a latestActivity for the running ticket within 20s');

    // Ask the stream for exactly the event after sequence-1: the frame the
    // marker claims to be.
    const frames = await readFrames(port, token, marker.sequence - 1, 1, 10_000);
    assert.ok(frames.length > 0, `the stream sent no frame after sequence ${marker.sequence - 1}`);
    const f = frames[0];
    assert.equal(f.name, 'worker_progress',
      `the event at the board's marker sequence ${marker.sequence} is a ${f.name}, not a worker_progress`);
    assert.equal(Number(f.id), marker.sequence,
      'the frame id and latestActivity.sequence are different integers, so the page compares the wrong thing');
    assert.equal((f.data.payload as { state?: string }).state, marker.state,
      "the frame's payload.state and latestActivity.state disagree for the same event");
  });
});

test('the page reads the board activity field by the name the daemon actually sends', async () => {
  // Derived from the live response, not from a constant: whatever key really
  // holds the mapped activity is the key the page has to read.
  await withLiveDaemon(async ({ port, token, projectId, ticketId }) => {
    let row: Record<string, unknown> | undefined;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const board = (await get(port, token, `/board?project=${projectId}`)).json as {
        tickets: Array<Record<string, unknown>>;
      } | null;
      const t = board?.tickets.find((x) => x.id === ticketId);
      const candidate = t && Object.entries(t).find(
        ([, v]) => v !== null && typeof v === 'object' && 'state' in (v as object) && 'sequence' in (v as object),
      );
      if (candidate) { row = t; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(row, 'no board row ever reported a mapped activity within 20s');

    const key = Object.entries(row).find(
      ([, v]) => v !== null && typeof v === 'object' && 'state' in (v as object) && 'sequence' in (v as object),
    )![0];

    assert.ok(APP.includes(`.${key}`),
      `the daemon sends the ticket's activity as "${key}" and app.js never reads that name -- ` +
      'the live line and the polling fallback are both permanently empty');
  });
});
