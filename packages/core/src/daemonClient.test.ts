import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { consumeEventStream, daemonRequest, DaemonUnreachableError, probeDaemonHealth } from './daemonClient.ts';
import type { DaemonFileInfo } from './daemon.ts';

// daemonRequest/probeDaemonHealth are generic HTTP-shaping utilities with no
// daemon-specific behaviour of their own (they don't know anything about
// tickets, projects, or the scheduler) -- tested here against a bare
// node:http server standing in for "some server on a port", the same way
// process.ts's own generic pieces get unit tests. What they do WITH a real
// daemon (real auth, real routes) is daemonApi.test.ts's job, against the
// real spawned `magarine serve` process.

interface Target {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

// server.listen() is asynchronous: server.address() is null until the
// 'listening' event actually fires, so this must be awaited rather than
// read back synchronously right after calling listen() -- an earlier
// version of this file did that and every test failed instantly with a
// null-dereference, leaving each unclosed server's listen() callback still
// pending and the whole `node --test` process hanging afterward with no
// further output.
function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Target> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

test('daemonRequest sends the bearer token and parses a JSON response', async () => {
  let receivedAuth: string | undefined;
  const target = await listen((req, res) => {
    receivedAuth = req.headers.authorization;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const result = await daemonRequest({ port: target.port, token: 'secret-token' }, 'GET', '/whatever');
    assert.equal(receivedAuth, 'Bearer secret-token');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true });
  } finally {
    await target.close();
  }
});

test('daemonRequest sends a JSON body and Content-Type only when a body is given', async () => {
  const seen: Array<{ method: string; contentType: string | undefined; body: string }> = [];
  const target = await listen((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', contentType: req.headers['content-type'], body: data });
      res.end('{}');
    });
  });
  try {
    await daemonRequest({ port: target.port, token: 't' }, 'GET', '/x');
    await daemonRequest({ port: target.port, token: 't' }, 'POST', '/y', { a: 1 });

    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].contentType, undefined);
    assert.equal(seen[0].body, '');

    assert.equal(seen[1].method, 'POST');
    assert.equal(seen[1].contentType, 'application/json');
    assert.deepEqual(JSON.parse(seen[1].body), { a: 1 });
  } finally {
    await target.close();
  }
});

test('daemonRequest returns non-2xx responses normally (not a throw), with the parsed error body', async () => {
  const target = await listen((_req, res) => {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  try {
    const result = await daemonRequest({ port: target.port, token: 'wrong' }, 'GET', '/health');
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: 'unauthorized' });
  } finally {
    await target.close();
  }
});

test('daemonRequest throws DaemonUnreachableError when nothing is listening on the port', async () => {
  // Grab a free port and immediately release it -- nothing should be
  // listening on it a moment later.
  const probe = await listen((_req, res) => res.end());
  const freePort = probe.port;
  await probe.close();

  await assert.rejects(() => daemonRequest({ port: freePort, token: 't' }, 'GET', '/health'), DaemonUnreachableError);
});

function sampleInfo(overrides: Partial<DaemonFileInfo> = {}): DaemonFileInfo {
  return {
    pid: 12345,
    port: 0,
    token: 'tok',
    startedAt: new Date().toISOString(),
    dbPath: '/x/magarine.db',
    ...overrides,
  };
}

test('probeDaemonHealth is true only when /health answers 200 with the SAME pid the caller expects', async () => {
  const target = await listen((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ pid: 12345, startedAt: new Date().toISOString(), uptimeMs: 1 }));
  });
  try {
    assert.equal(await probeDaemonHealth(sampleInfo({ port: target.port, pid: 12345 })), true);
    // A foreign process happens to be listening on that port under a
    // different pid (e.g. the OS reassigned it after a crash) -- must not
    // be mistaken for the original daemon.
    assert.equal(await probeDaemonHealth(sampleInfo({ port: target.port, pid: 999 })), false);
  } finally {
    await target.close();
  }
});

test('probeDaemonHealth is false when nothing answers at all', async () => {
  const probe = await listen((_req, res) => res.end());
  const freePort = probe.port;
  await probe.close();
  assert.equal(await probeDaemonHealth(sampleInfo({ port: freePort })), false);
});

// Batch 15 ruling 7 item 2: consumeEventStream is daemonApi.ts's SSE route's
// one consumer -- generic frame parsing tested here against a bare
// node:http server writing raw SSE bytes, the same "no daemon-specific
// behaviour" split this file's own header comment already draws for
// daemonRequest/probeDaemonHealth. What a REAL daemon's real route emits is
// daemonApi.test.ts's job, against the real spawned `magarine serve`.

test('consumeEventStream sends the bearer token, never the token in the URL, and parses id/event/data frames in order, skipping comment (heartbeat) lines', async () => {
  let receivedAuth: string | undefined;
  let receivedUrl: string | undefined;
  const target = await listen((req, res) => {
    receivedAuth = req.headers.authorization;
    receivedUrl = req.url;
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('id: 3\nevent: worker_progress\ndata: {"sequence":3,"eventType":"worker_progress"}\n\n');
    res.write(': heartbeat\n\n');
    res.write('id: 4\nevent: worker_done\ndata: {"sequence":4,"eventType":"worker_done"}\n\n');
    res.end();
  });
  try {
    const events: Array<{ id: number; event: string; data: unknown }> = [];
    for await (const event of consumeEventStream({ port: target.port, token: 'secret-token' }, { since: 2 })) {
      events.push(event);
    }
    assert.equal(receivedAuth, 'Bearer secret-token');
    assert.doesNotMatch(receivedUrl ?? '', /secret-token/, 'the token must never appear in the URL');
    assert.match(receivedUrl ?? '', /since=2/);
    assert.deepEqual(events, [
      { id: 3, event: 'worker_progress', data: { sequence: 3, eventType: 'worker_progress' } },
      { id: 4, event: 'worker_done', data: { sequence: 4, eventType: 'worker_done' } },
    ]);
  } finally {
    await target.close();
  }
});

test('consumeEventStream handles a frame split across multiple TCP chunks', async () => {
  const target = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('id: 1\nev');
    setTimeout(() => {
      res.write('ent: x\ndata: {"sequence":1}\n\n');
      res.end();
    }, 10);
  });
  try {
    const events: Array<{ id: number; event: string; data: unknown }> = [];
    for await (const event of consumeEventStream({ port: target.port, token: 't' })) {
      events.push(event);
    }
    assert.deepEqual(events, [{ id: 1, event: 'x', data: { sequence: 1 } }]);
  } finally {
    await target.close();
  }
});
