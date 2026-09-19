// THE PAGE, TESTED BY RUNNING IT, AGAINST A REAL DAEMON. Batch 16 Role B,
// under ruling 26 (docs/strategy/batch-16-addendum-2-page-testing-state.md).
//
// Every other test under src/ui/ reads the page's files as text. This one
// executes `ui/app.js` in `src/ui/domHarness.ts` and lets it talk, over a real
// loopback connection with Node's own fetch, to a real `magarine serve`
// spawned per test. THERE ARE NO FIXTURES: the daemon is the fixture. A
// hand-written response cannot contradict the page it was written from, which
// is exactly how the `.shots` stub sent `latest_activity` and agreed with the
// page's bug through eleven screenshots.
//
// WHAT THESE TESTS MAY CLAIM: the script's state-to-DOM behaviour under real
// daemon responses. NOT rendering, layout, focus, motion, contrast or the live
// stream — Node has no EventSource, so the page takes its own "stream
// unavailable, polling" branch here. Those belong to src/ui/browser.test.ts.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot } from '../testSupport.ts';
import { DatabaseSync } from 'node:sqlite';
import { withDaemon } from './testDaemon.ts';
import { openPage } from './domHarness.ts';
import { UI_DIR } from './page.ts';

const root = testTempRoot('ui-run');
after(root.cleanup);

const optionValues = (page: ReturnType<typeof openPage>) =>
  page.byId('projectSelect').children.map((o) => o.value);

/** Runs the page's own poll until `check` holds. Nothing here reaches into the page's state. */
async function pollUntil(page: ReturnType<typeof openPage>, check: () => boolean, message: string, tries = 20) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await page.poll();
  }
  if (!check()) throw new Error(`the page never reached: ${message}`);
}

// ------------------------------------------------ item 1: a new project appears

test('a project created while the page is open reaches the selector, with no reload', async () => {
  // The owner hit this during their demo: they created a project in a terminal
  // and it stayed invisible until F5. This is that, exactly: the project is
  // created by the REAL CLI against the state directory the daemon is serving,
  // while the page is loaded, and nobody reloads anything.
  await withDaemon(root, async (d) => {
    const alpha = await d.createProject('Alpha');
    const page = openPage({ baseUrl: d.baseUrl, token: d.token });
    await page.waitFor(() => optionValues(page).length === 1, 'the first project to reach the selector');
    assert.deepEqual(optionValues(page), [alpha.id]);

    const beta = await d.createProject('Beta');
    await page.poll();

    assert.deepEqual(optionValues(page).sort(), [alpha.id, beta.id].sort(),
      'the new project never reached the selector -- the page still needs a reload to see it');
    assert.ok(page.byId('projectSelect').children.some((o) => o.textContent === 'Beta'),
      'the new project reached the selector without its name');
  });
});

test('the poll asks the daemon for the project list, not only for the board', async () => {
  // The mechanism behind the test above, asserted directly.
  await withDaemon(root, async (d) => {
    await d.createProject('Alpha');
    const page = openPage({ baseUrl: d.baseUrl, token: d.token });
    await page.waitFor(() => optionValues(page).length === 1, 'the page to load');
    const before = page.requests.length;

    await page.poll();

    const polled = page.requests.slice(before);
    assert.ok(polled.some((p) => p.split('?')[0] === '/projects'),
      `the poll fetched ${polled.join(', ')} -- none of them the project list`);
  });
});

test('a poll that changes nothing leaves the selection, and the option elements, alone', async () => {
  // THE HALF THAT IS EASY TO GET WRONG, and the one the owner would meet every
  // day: rebuilding the selector every four seconds resets the value and
  // destroys the very <option> elements they may have open.
  await withDaemon(root, async (d) => {
    await d.createProject('Alpha');
    const beta = await d.createProject('Beta');
    const page = openPage({ baseUrl: d.baseUrl, token: d.token });
    await page.waitFor(() => optionValues(page).length === 2, 'both projects to reach the selector');

    const select = page.byId('projectSelect');
    select.value = beta.id;
    select.dispatch('change');
    await page.settle();
    assert.equal(page.text('projectId'), beta.id);
    const optionsBefore = select.children;

    await page.poll();                       // the same two projects, again

    assert.equal(select.value, beta.id, "the poll reset the owner's chosen project");
    assert.equal(page.text('projectId'), beta.id);
    const optionsAfter = select.children;
    assert.equal(optionsAfter.length, 2);
    assert.equal(optionsAfter[0], optionsBefore[0],
      'the selector was rebuilt although the list had not changed -- these are new elements');
    assert.equal(optionsAfter[1], optionsBefore[1]);
  });
});

test('a project that leaves the daemon does not leave the page pointed at it', async () => {
  // The other side of "rebuild only when the list changed". There is no
  // `project delete` command, and a RESTARTED daemon is not the scenario: it
  // mints a new token, so the real page would be sitting at the gate. So the
  // row is removed underneath the running daemon with a real SQL write on its
  // own database, and the daemon -- untouched, still serving -- reports the
  // shorter list from its next read.
  await withDaemon(root, async (d) => {
    await d.createProject('Alpha');
    const beta = await d.createProject('Beta');
    const page = openPage({ baseUrl: d.baseUrl, token: d.token });
    await page.waitFor(() => optionValues(page).length === 2, 'both projects to reach the selector');

    const select = page.byId('projectSelect');
    select.value = beta.id;
    select.dispatch('change');
    await page.settle();
    assert.equal(page.text('projectId'), beta.id);

    const db = new DatabaseSync(d.dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    db.prepare('DELETE FROM projects WHERE id = ?').run(beta.id);
    db.close();

    await pollUntil(page, () => optionValues(page).length === 1, 'the shorter project list');

    assert.notEqual(select.value, beta.id, 'the page is still pointed at a project the daemon no longer lists');
    assert.equal(select.value, optionValues(page)[0]);
    assert.equal(page.text('projectId'), optionValues(page)[0]);
  });
});

// --------------------------- item 2: the pause banner knows the readiness cause

// WHY THIS HALF IS NOT A RUN TEST YET, and what would make it one.
//
// Ruling 26 says item 2 "asserts against the shape the ruling states, marked as
// such in the test name" until Role A's item 5 lands. It cannot be a run test
// before then, and the reason is sharper than "the pause path does not exist":
// `store.ts`'s row mapper WHITELISTS the reason —
//
//     pauseReason: row.pause_reason === 'spend_cap' || row.pause_reason === 'adapter_unavailable'
//                  ? row.pause_reason : null
//
// — so even a readiness reason written straight into the database comes back
// from `GET /board` as null. There is no way, today, to make a real daemon
// send this page a readiness cause. Role A's item 5 has to widen that mapper,
// `BoardResult.pauseReason`'s type (commands/board.ts:116) and
// `describeProjectPause` (commands/inbox.ts:201) together, or the page can
// never see the reason however the scheduler pauses the project.
//
// So the two tests below assert the SHAPE, from the page's source, and say so
// in their names. They convert to run tests the day the real path lands.

const APP = readFileSync(join(UI_DIR, 'app.js'), 'utf8');

test('shape only, until Role A item 5: the page knows every readiness cause ruling 24 names', () => {
  // Ruling 24's three rules: no workspace_root, an unsafe workspace_root, no
  // scope_path. The fourth is carried in case the daemon names the family
  // rather than the rule; this list is the one place to change if Role A
  // spells them differently.
  for (const reason of ['missing_workspace_root', 'unsafe_workspace_root', 'missing_scope_path', 'project_not_ready']) {
    assert.match(APP, new RegExp(`READINESS_REASONS[\\s\\S]{0,200}'${reason}'`),
      `app.js does not treat ${reason} as a readiness cause, so its banner would offer no fix`);
    assert.match(APP, new RegExp(`${reason}: 'Paused`),
      `app.js has no heading for ${reason}, so its banner would read like any other pause`);
  }
});

test('shape only, until Role A item 5: a readiness pause offers the command and not a Resume button', () => {
  // The command carries the project id the page already has; ruling 24 makes
  // `project set --dir` the un-pause, so a Resume button here would be one
  // that cannot work.
  const fn = APP.slice(APP.indexOf('function renderPause('), APP.indexOf('// FONT READINESS'));
  assert.match(fn, /magarine project set --project ' \+\s*\(state\.projectId \|\| ''\) \+ ' --dir <folder>'/,
    'the fix command is not offered with the project id filled in');
  const readinessBranch = fn.slice(fn.indexOf('READINESS_REASONS.indexOf'));
  assert.match(readinessBranch.slice(0, 400), /return;/,
    'the readiness branch does not return before the Resume button is added');
});

// ------------------------------------------- the banner, against a real daemon

test('a project the daemon does not report as paused shows no banner at all', async () => {
  // The negative half of item 2, and it IS a run test: a real project, a real
  // board, and the banner stays hidden.
  await withDaemon(root, async (d) => {
    await d.createProject('Alpha');
    const page = openPage({ baseUrl: d.baseUrl, token: d.token });
    await page.waitFor(() => optionValues(page).length === 1, 'the project to load');
    assert.equal(page.byId('pauseBanner').hidden, true);
    assert.equal(page.text('pauseBody'), '');
  });
});

// ------------------------------------- ruling 26's conditions, as tests

test('the harness takes its elements from the real index.html, and says so when one is gone', async () => {
  // CONDITION 1. The point of this is that the harness cannot invent an
  // element: if a future edit drops or renames an id in the shipped page, the
  // test that needed it fails instead of quietly passing against a stand-in.
  await withDaemon(root, async (d) => {
    const page = openPage({ baseUrl: d.baseUrl, token: d.token });
    assert.ok(page.byId('pauseBanner'), '#pauseBanner is in index.html and should be here');
    assert.throws(() => page.byId('a-region-the-page-does-not-have'), /no #a-region-the-page-does-not-have/);
  });
});

test('the harness throws on anything it does not implement, rather than answering plausibly', async () => {
  // CONDITION 2, and the reason for it: a shim that returns "" or null for an
  // API it does not have is a fixture agreeing with itself. Every one of these
  // is something a browser has and this harness deliberately does not.
  await withDaemon(root, async (d) => {
    const page = openPage({ baseUrl: d.baseUrl, token: d.token });
    const el = page.byId('pauseBanner');
    assert.throws(() => el.style, /not implemented/, 'element.style answered instead of throwing');
    assert.throws(() => el.classList, /not implemented/, 'element.classList answered instead of throwing');
    assert.throws(() => page.document.querySelectorAll('#a, #b'), /not implemented/,
      'a selector list answered instead of throwing');
    assert.throws(() => page.document.querySelectorAll('div > span'), /not implemented/,
      'a child combinator answered instead of throwing');
  });
});
