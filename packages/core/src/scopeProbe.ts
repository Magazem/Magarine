import { accessSync, constants, statSync } from 'node:fs';
import type { ScopeProbe } from './readiness.ts';

// The filesystem-backed `ScopeProbe` production call sites hand to
// `projectReadiness` (ruling 29, batch 16 addendum 5). readiness.ts itself
// stays pure -- it never imports `fs` -- so the disk enters only here, and
// tests pass a stub instead.
//
// 'absent' is ONLY "no such file" (ENOENT/ENOTDIR): a missing scope document
// is a legibility gap, not a failure. Everything else that stops the file
// being read -- a permissions error, a directory at that path, a path that
// cannot be resolved -- is `{ unreadable: <the real error> }`, never folded
// into 'absent' (rule 9: an unreadable file must not be reported as an empty
// one), and the error travels so the pause can name it.
export const probeScopeFile: ScopeProbe = (path) => {
  try {
    if (!statSync(path).isFile()) return { unreadable: 'EISDIR: something that is not a file (a directory) is at this path' };
    accessSync(path, constants.R_OK);
    return 'present';
  } catch (err) {
    const { code, message } = err as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent';
    // The OS's own words, path stripped (the message names the path already).
    return { unreadable: `${code ?? 'error'}: ${message.replace(/^[A-Z]+: /, '').replace(/,? (stat|access|open) '.*'$/, '')}` };
  }
};

// Ruling 29 point 2: the one line `project create` and `plan` print when the
// scope document is not there. Null when it exists (or is unreadable, which
// is a readiness failure reported by its own pause, not this line) -- it is
// printed ONLY when absent, so a present file makes no noise. The probe is
// injected like everywhere else, so the wording is testable without disk.
export function scopeAnnouncement(scopePath: string | null, probe: ScopeProbe): string | null {
  if (!scopePath) return null;
  if (probe(scopePath) !== 'absent') return null;
  return `scope document: ${scopePath} (not found; write it before plan, or the Manager will start by interviewing you)`;
}
