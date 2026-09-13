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
