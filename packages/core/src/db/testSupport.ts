import { rmSync } from 'node:fs';

// node:sqlite is native and, on Windows, closing a DatabaseSync does not
// always release its file handle synchronously — an rmSync of the
// containing temp directory immediately after db.close() can EPERM even
// though the code did everything right. Verified HARD: this reproduces
// deterministically under `node --test` (not under a plain `node` process)
// once a migration touches the file enough to shift timing, and a short
// retry loop clears it every time. Test-only; never used by product code.
export async function rmSyncResilient(path: string, attempts = 10, delayMs = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
}
