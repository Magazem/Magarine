// Test double for the `claude` executable. Spawned only from
// claudeCli.test.ts, never from production code. It ignores whatever argv it
// was actually invoked with (it is not asked to validate flags — that is
// Role D/process.ts's territory) and instead replays behaviour described by
// the MAGARINE_FAKE_SPEC environment variable, a JSON object:
//
//   { stdoutFile?: string; stderrFile?: string; exitCode?: number;
//     sleepMs?: number; createFiles?: Record<string, string> }
//
// stdoutFile/stderrFile point at real recorded bytes under
// spikes/claude-cli/runs/ (read, never modified). createFiles lets a test
// simulate (or withhold) the side effects a real worker would have made in
// its workspace, independent of what the replayed stdout claims.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface FakeSpec {
  stdoutFile?: string;
  stderrFile?: string;
  exitCode?: number;
  sleepMs?: number;
  createFiles?: Record<string, string>;
}

async function main(): Promise<void> {
  const spec: FakeSpec = JSON.parse(process.env.MAGARINE_FAKE_SPEC ?? '{}');

  if (spec.sleepMs) {
    await new Promise((resolve) => setTimeout(resolve, spec.sleepMs));
  }

  for (const [relPath, content] of Object.entries(spec.createFiles ?? {})) {
    const full = join(process.cwd(), relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  if (spec.stdoutFile && existsSync(spec.stdoutFile)) {
    process.stdout.write(readFileSync(spec.stdoutFile));
  }
  if (spec.stderrFile && existsSync(spec.stderrFile)) {
    process.stderr.write(readFileSync(spec.stderrFile));
  }

  process.exitCode = spec.exitCode ?? 0;
}

void main();
