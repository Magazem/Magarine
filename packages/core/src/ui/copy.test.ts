// THE PAGE SPEAKS TO THE OWNER, NOT TO THE TEAM. Batch 18 Role B item 1
// (batch-17-addendum-3 section 4).
//
// The stranger's walk found developer prose printed in the owner's product
// ("ui/ELEMENT-FIELD-TABLE.md", "BoardTicket.model", "GET /activity") and raw
// state names on a failed Manager turn. These tests keep both out. The daemon
// is the fixture (ruling 26): a real `magarine serve`, a real CLI, real
// responses. The one exception is named where it is used.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot } from '../testSupport.ts';
import { withDaemon, runCli } from './testDaemon.ts';
import { openPage } from './domHarness.ts';
import { UI_DIR } from './page.ts';

const root = testTempRoot('ui-copy');
after(root.cleanup);

// Comments are for the team and are never rendered; only what a person can see is held to this.
const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

test('the served page carries no legend element and none of the implementation prose the legends held', () => {
  assert.doesNotMatch(html, /class="legend"/, 'a legend element is back in the page');
  for (const phrase of ['ELEMENT-FIELD-TABLE', 'Nothing on this page is invented', 'BoardTicket', 'GET /activity',
    'Identity is generated', 'defaultModel', 'worker_progress']) {
    assert.ok(!html.includes(phrase), `implementation prose is back in the page: "${phrase}"`);
  }
});

async function pollUntil(page: ReturnType<typeof openPage>, check: () => boolean, message: string, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await page.poll();
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!check()) throw new Error(`the page never reached: ${message}`);
}

test('an empty board says what to do next, and the line goes when a ticket exists', async () => {
  await withDaemon(root, async (d) => {
    const p = await d.createProject('Empty');
    const page = openPage({ baseUrl: d.baseUrl, token: d.token });
    await pollUntil(page, () => page.text('boardEmpty').length > 0, 'the empty-board line');
    assert.equal(page.byId('boardEmpty').hidden, false);
    assert.match(page.text('boardEmpty'), /No tickets yet\. Open the Manager tab/);

    await runCli(['ticket', 'add', '--project', p.id, '--title', 'first', '--state-dir', d.stateDir, '--json']);
    await pollUntil(page, () => page.byId('boardEmpty').hidden, 'the empty-board line to go');
    assert.equal(page.text('boardEmpty'), '');
  });
});

test('a Manager turn is named the Manager on its card and in Needs You, with no raw event name shown', async () => {
  // A real Manager ticket: `discuss` makes one, and the default adapter cannot
  // answer it, so it fails for good and the daemon raises worker_failed_final.
  await withDaemon(root, async (d) => {
    const p = await d.createProject('Talk');
    await runCli(['discuss', '--project', p.id, '--message', 'hello', '--state-dir', d.stateDir]);
    const page = openPage({ baseUrl: d.baseUrl, token: d.token });
    await pollUntil(page, () => page.text('needsList').includes('Stopped for good'), 'the failed Manager turn in Needs You', 80);

    const needs = page.text('needsList');
    assert.match(needs, /Manager · Stopped for good/, 'the row does not name the Manager');
    assert.doesNotMatch(needs, /worker_failed_final|WORKER_FAILED_FINAL/, 'a raw event name is on screen');
    assert.match(page.text('lanes'), /Manager · tkt_/, 'the board card does not name the Manager');
    assert.doesNotMatch(page.text('feed'), /worker_failed_final|dependencies_resolved|worker_failed_retryable/,
      'raw event names are in the activity feed');
    assert.match(page.text('feed'), /Ready to run/);
  }, ['--adapter', 'fake']);
});

test('an event name the page has no copy for is shown as the daemon spelled it, never blank', async () => {
  // THE ONE REWRITE in this file: the real inbox response is passed through
  // with its event type replaced by a name that no page has ever heard of --
  // the only way to present an unmapped name, since the daemon will not invent one.
  await withDaemon(root, async (d) => {
    const p = await d.createProject('Unknown');
    await runCli(['discuss', '--project', p.id, '--message', 'hello', '--state-dir', d.stateDir]);
    const page = openPage({
      baseUrl: d.baseUrl, token: d.token,
      rewriteJson: (path, body) => (path.startsWith('/inbox') && Array.isArray(body)
        ? body.map((i: any) => ({ ...i, eventType: 'some_future_event' })) : body),
    });
    await pollUntil(page, () => page.text('needsList').includes('some_future_event'), 'the unmapped name on screen', 80);
    assert.match(page.text('needsList'), /Manager · some_future_event/);
  }, ['--adapter', 'fake']);
});
