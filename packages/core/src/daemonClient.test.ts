import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { daemonRequest, DaemonUnreachableError, probeDaemonHealth } from './daemonClient.ts';
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
