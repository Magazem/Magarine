import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnManaged } from '../process.ts';
import { testTempRoot } from '../testSupport.ts';
import { PAGE_HTML } from './page.ts';

// PAGE_HTML is never bundled or transpiled -- it is shipped and parsed by a
// real browser exactly as written in this string. Nothing else in this
// project's test suite would ever load it as JavaScript and notice a typo
// (a stray comma, an unclosed brace) before a person actually opened the
// page, so this extracts the inline <script> body and asks `node --check`
// to parse it -- a syntax check only, no DOM/fetch globals needed, since
// `--check` never executes the file.
const testRoot = testTempRoot('page-script');
after(testRoot.cleanup);

test('the page\'s inline <script> is syntactically valid JavaScript', async () => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(PAGE_HTML);
  assert.ok(match, 'PAGE_HTML must contain exactly one inline <script> block');
  const scriptBody = match![1];
  assert.ok(scriptBody.trim().length > 0);

  const scriptPath = join(testRoot.root, 'page-script.js');
  writeFileSync(scriptPath, scriptBody, 'utf8');

  const proc = spawnManaged({ executable: process.execPath, args: ['--check', scriptPath] });
  let stderr = '';
  proc.onStderr((c) => (stderr += c));
  const result = await proc.wait();
  assert.equal(result.code, 0, `node --check failed:\n${stderr}`);
});
