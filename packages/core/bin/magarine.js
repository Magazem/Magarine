#!/usr/bin/env node
// The `magarine` binary (see package.json's `bin` field). Plain JavaScript,
// not TypeScript: this file has to run and print a clear message on ANY
// Node version, including one too old to understand `src/cli.ts`'s type
// syntax at all -- if this file itself were `.ts`, an old Node would fail
// with an opaque "Unknown file extension" before ever reaching the version
// check below. It never spawns a second process: after the version check
// passes, it `import()`s cli.ts directly into THIS process, so
// `process.argv` reaches it unchanged and cli.ts itself needed no change to
// be run this way.

const [major] = process.versions.node.split('.').map(Number);
if (!(major >= 24)) {
  console.error(
    `magarine requires Node.js 24 or newer (found ${process.versions.node}). Install a newer Node.js and try again: https://nodejs.org/`
  );
  process.exit(1);
}

await import('../src/cli.ts');
