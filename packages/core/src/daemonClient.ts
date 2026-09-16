import type { DaemonFileInfo } from './daemon.ts';

// The one client module every caller of the daemon's HTTP API goes through
// -- per docs/strategy/batch-8-spec.md's Role M item 3. Node's built-in
// `fetch` only; no dependency added for this. Step 3 delivers this module
// and daemon.ts's own use of it (the health leg of stale-file detection);
// wiring cli.ts's mutating commands through it is step 4's job, not this
// one's.

export interface DaemonResponse<T = unknown> {
  status: number;
  body: T;
}

// Thrown by request() only for a transport-level failure (the daemon is not
// actually reachable at that port) -- a well-formed HTTP error response
// (401, 400, 404, 409, ...) is returned normally as a DaemonResponse, not
// thrown, so a caller can inspect `.status` without a try/catch for the
// ordinary "the daemon said no" case.
export class DaemonUnreachableError extends Error {}

// Never logs, includes, or echoes `info.token` anywhere in a thrown error --
// only the path and the underlying transport failure's own message, which
// comes from Node's fetch/undici and does not carry the request we sent.
export async function daemonRequest<T = unknown>(
  info: Pick<DaemonFileInfo, 'port' | 'token'>,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<DaemonResponse<T>> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${info.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new DaemonUnreachableError(
      `could not reach the daemon at 127.0.0.1:${info.port}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const text = await res.text();
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not a JSON body (should not happen against this daemon's own API,
      // which always responds JSON -- left undefined rather than throwing,
      // so a caller only checking `.status` is never surprised).
    }
  }
  return { status: res.status, body: parsed as T };
}

// Used by daemon.ts's checkDaemonFile as the "healthCheck" half of staleness
// detection (the pid-liveness half is checked separately, in-process, and
// needs no network call). True only when the daemon at `info.port` answers
// `/health` with 200 AND reports the SAME pid the file claims -- a
// coincidence where the OS reassigned that port to an unrelated process
// after a crash must not be mistaken for the original daemon still being up.
export async function probeDaemonHealth(info: DaemonFileInfo): Promise<boolean> {
  try {
    const { status, body } = await daemonRequest<{ pid?: number }>(info, 'GET', '/health');
    return status === 200 && body?.pid === info.pid;
  } catch {
    return false;
  }
}

// Batch 15 ruling 7 item 2: the one consumer of `GET /events?since=`
// (daemonApi.ts), and the reason that route exists at all -- the page's own
// `fetch()` carries the token in a header exactly like every other route,
// never a query string, because a browser's `EventSource` cannot set
// headers and a token in a URL lands in logs and history (see
// daemonApi.ts's own module comment). Generic SSE-frame parsing, no
// daemon-specific behaviour, tested here against a bare http server (same
// split as daemonRequest/probeDaemonHealth above); what a real daemon's
// real route emits end to end is daemonApi.test.ts's job.
export interface StreamedEvent {
  id: number;
  event: string;
  data: unknown;
}

// A comment line (starts with ':', per the SSE spec) never matches any of
// the three field prefixes below -- a valid comment can never start with
// "id:"/"event:"/"data:" and still be a comment, since that would require
// its very first character not to be ':' -- so a comment-only frame (the
// daemon's every-fifteen-second heartbeat, in particular) naturally leaves
// every field undefined below and is skipped by the same check that skips
// any other incomplete frame, with no separate branch needed for it.
function parseSseFrame(frame: string): StreamedEvent | undefined {
  let id: number | undefined;
  let eventType: string | undefined;
  let dataText: string | undefined;
  for (const line of frame.split('\n')) {
    if (line.startsWith('id:')) id = Number(line.slice(3).trim());
    else if (line.startsWith('event:')) eventType = line.slice(6).trim();
    else if (line.startsWith('data:')) dataText = line.slice(5).trim();
  }
  if (id === undefined || Number.isNaN(id) || eventType === undefined || dataText === undefined) return undefined;
  return { id, event: eventType, data: JSON.parse(dataText) };
}

// Consumes the daemon's `GET /events?since=<sequence>` stream and yields
// one StreamedEvent per non-comment SSE frame, in the order the server sent
// them. A streaming `fetch()`, never `EventSource` -- see this function's
// own header comment for why. Ends (the generator returns) when the
// server's response body ends, which is exactly what happens when the
// daemon calls its own stream registry's closeAllStreams() on shutdown
// (daemonApi.ts) -- a caller sees a clean end of iteration, not a hang or a
// thrown error, the moment the daemon stops.
export async function* consumeEventStream(
  info: Pick<DaemonFileInfo, 'port' | 'token'>,
  opts: { since?: number; signal?: AbortSignal } = {}
): AsyncGenerator<StreamedEvent, void, void> {
  const since = opts.since ?? 0;
  const res = await fetch(`http://127.0.0.1:${info.port}/events?since=${since}`, {
    headers: { Authorization: `Bearer ${info.token}` },
    signal: opts.signal,
  });
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) yield parsed;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
