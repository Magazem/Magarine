// THE FLEET IS THE ROSTER. Batch 19 mini-phase 3A, ruling 38
// (docs/strategy/batch-19-item-3a-the-roster-on-the-page.md), with its
// amendment: a profile's organism is organism('mg.v1:<id>', model), and the
// add form's model list is the daemon's own GET /models.
//
// Every test drives a REAL daemon (src/ui/scriptedDaemon.ts: the real loop and
// request handler over a real sqlite file, the fake adapter) and reads what the
// real ui/app.js draws from its real responses. There are no fixtures: the six
// profiles are the ones migration 0017 seeds, and every write goes through the
// daemon's own routes. What each element is drawn from is in
// ui/ELEMENT-FIELD-TABLE.md section 2, and the last test holds the table to it.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { testTempRoot } from '../testSupport.ts';
import { createProject, createTicket } from '../store.ts';
import { withScriptedDaemon, type ScriptedDaemon } from './scriptedDaemon.ts';
import { withDaemon } from './testDaemon.ts';
import { openPage } from './domHarness.ts';
import { UI_DIR } from './page.ts';

const root = testTempRoot('ui-roster');
after(root.cleanup);

type OpenedPage = ReturnType<typeof openPage>;
type El = OpenedPage['document']['body'];

interface Profile { id: string; name: string; model: string; purpose: string; status: string; ticketId: string | null }

async function open(d: ScriptedDaemon, projects = 1): Promise<OpenedPage> {
  const page = openPage({ baseUrl: d.baseUrl, token: d.token });
  await page.waitFor(() => page.byId('projectSelect').children.length === projects, 'the projects to reach the selector');
  if (projects > 1) {
    page.byId('projectSelect').value = d.projectId;
    page.byId('projectSelect').dispatch('change');
    await page.settle();
  }
  return page;
}

async function pollUntil(page: OpenedPage, check: () => boolean, message: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await page.poll();
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!check()) throw new Error(`the page never reached: ${message}`);
}

async function call(d: ScriptedDaemon, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${d.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${d.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const profiles = async (d: ScriptedDaemon): Promise<Profile[]> => (await call(d, 'GET', '/profiles')).json;

/** Every descendant carrying `cls` among its class names. The harness has no class selector, deliberately. */
function byClass(node: El, cls: string): El[] {
  const out: El[] = [];
  for (const c of node.children) {
    if (c.className.split(' ').includes(cls)) out.push(c);
    out.push(...byClass(c, cls));
  }
  return out;
}
const one = (node: El, cls: string): El | null => byClass(node, cls)[0] ?? null;

const rows = (page: OpenedPage) => byClass(page.byId('fleetList'), 'fleet-row');
const rowNamed = (page: OpenedPage, name: string) => rows(page).find((r) => one(r, 'name')?.textContent === name) ?? null;

/** Which of the organism's 25 cells the page lit. */
function cells(row: El): string {
  return one(row, 'org')!.children.map((c) => (c.getAttribute('data-on') ? '1' : '0')).join('');
}
/** What the organism DRAWS: its tier (aria-label) and its cells. */
const drawn = (row: El): string => one(row, 'org')!.getAttribute('aria-label') + ' ' + cells(row);

/** The shipped generator, run on its own: the cells a given seed and model must produce. */
function generated(seed: string, model: string): string {
  const ctx = createContext({} as Record<string, unknown>);
  runInContext(readFileSync(join(UI_DIR, 'organism.js'), 'utf8'), ctx);
  const org = (ctx as { MagarineOrganism: { organism(s: string, m?: string): number[] } }).MagarineOrganism;
  return org.organism(seed, model).map((c) => String(c)).join('');
}

function buttonLabelled(row: El, label: string): El {
  const b = row.querySelectorAll('button').find((x) => (x.getAttribute('aria-label') ?? x.textContent) === label);
  assert.ok(b, `no button labelled "${label}" in the row`);
  return b!;
}

/** A work ticket assigned to a profile, the way `ticket add --profile` makes one. */
function profileTicket(d: ScriptedDaemon, profile: string, title: string, projectId = d.projectId) {
  return createTicket(d.db, {
    projectId, title, description: 'do the thing', acceptanceCriteria: ['it works'], workspaceType: 'NONE', profile,
  });
}

// ------------------------------------------------------ acceptance 1 ----

test('with the six seeded profiles and nothing running, the roster shows six idle rows, each with its own organism, name, model and purpose', async () => {
  await withScriptedDaemon(root, async (d) => {
    const seeded = await profiles(d);
    assert.equal(seeded.length, 6, 'the daemon did not seed six profiles');
    const page = await open(d);
    await pollUntil(page, () => rows(page).length === 6, 'six roster rows');

    assert.match(readFileSync(join(UI_DIR, 'index.html'), 'utf8'), /<h2 id="fleetHead">Roster<\/h2>/, 'the region is not headed Roster');
    assert.equal(page.text('fleetCount'), '6 profiles', 'the count must count profiles, not tickets');
    const drawnRows = rows(page);
    // In the daemon's order, one per profile.
    assert.deepEqual(drawnRows.map((r) => one(r, 'name')!.textContent), seeded.map((p) => p.name));
    seeded.forEach((p, i) => {
      const r = drawnRows[i];
      assert.equal(one(r, 'tier')!.textContent, p.model);
      assert.equal(one(r, 'purpose')!.textContent, p.purpose);
      assert.equal(one(r, 'state')!.textContent, 'idle');
      assert.equal(one(r, 'doing'), null, 'an idle row has no activity line');
    });
    assert.equal(new Set(drawnRows.map(drawn)).size, 6, 'two profiles drew the same organism');
    assert.ok(!page.text('fleetList').includes('Running, not on the roster'), 'nothing is running, so there is no such line');
  });
});

// ------------------------------------------------------ acceptance 2 ----

test('a profile with a ticket IN_PROGRESS reads working with the ticket\'s title and the live line; every other row stays idle, and nothing draws a percentage', async () => {
  await withScriptedDaemon(root, async (d) => {
    const t = profileTicket(d, 'Developer', 'Write the parser');
    d.adapter.setScript(t.id, { kind: 'progress', message: 'tool_use: Write' });   // reports, then keeps running
    await d.tickOnly();
    await d.waitForStatus(t.id, ['IN_PROGRESS'], 'the Developer ticket running');

    const page = await open(d);
    await pollUntil(page, () => one(rowNamed(page, 'Developer') ?? page.byId('fleetList'), 'doing')?.textContent.startsWith('writing') ?? false,
      'the Developer row to carry the live line');

    const dev = rowNamed(page, 'Developer')!;
    assert.equal(one(dev, 'state')!.textContent, 'working · Write the parser');
    assert.equal(dev.getAttribute('data-status'), 'IN_PROGRESS');
    for (const r of rows(page)) {
      if (r === dev) continue;
      assert.equal(one(r, 'state')!.textContent, 'idle', `${one(r, 'name')!.textContent} is not idle`);
    }
    assert.ok(!page.text('fleetList').includes('Running, not on the roster'), 'a profiled ticket was drawn twice');
    assert.doesNotMatch(page.text('fleetList'), /\d+\s*%/, 'the roster shows a percentage');
    assert.equal(page.byId('fleetList').querySelectorAll('progress').length, 0, 'the roster draws a completion bar');
    assert.equal(page.byId('fleetList').querySelectorAll('[role="progressbar"]').length, 0, 'the roster draws a completion bar');
  });
});

test('a profile working on another project\'s ticket says working and names that ticket by its id', async () => {
  await withScriptedDaemon(root, async (d) => {
    const other = createProject(d.db, { name: 'Other', maxParallelWorkers: 2 });
    const t = profileTicket(d, 'Tester', 'Test the other thing', other.id);
    d.adapter.setScript(t.id, { kind: 'hang' });
    await d.loop.forceTick(other.id);
    await d.waitForStatus(t.id, ['IN_PROGRESS'], 'the other project\'s ticket running');

    const page = await open(d, 2);
    await pollUntil(page, () => one(rowNamed(page, 'Tester') ?? page.byId('fleetList'), 'state')?.textContent !== 'idle', 'the Tester row to read working');
    assert.equal(one(rowNamed(page, 'Tester')!, 'state')!.textContent, `working · ${t.id}`);
  });
});

// ------------------------------------------------------ acceptance 3 ----

test('renaming a profile leaves its drawn organism alone; moving it to a model in another tier changes it', async () => {
  await withScriptedDaemon(root, async (d) => {
    const dev = (await profiles(d)).find((p) => p.name === 'Developer')!;
    assert.match(dev.model, /sonnet/, 'this test moves Developer out of the sonnet tier, so it must start there');
    const page = await open(d);
    await pollUntil(page, () => rowNamed(page, 'Developer') !== null, 'the Developer row');
    const before = drawn(rowNamed(page, 'Developer')!);
    assert.match(before, /model tier sonnet/);
    // The drawn seed is the profile id, with the model beside it.
    assert.equal(cells(rowNamed(page, 'Developer')!), generated(`mg.v1:${dev.id}`, dev.model));

    assert.equal((await call(d, 'PATCH', `/profiles/${dev.id}`, { name: 'Builder' })).status, 200);
    await pollUntil(page, () => rowNamed(page, 'Builder') !== null, 'the renamed row');
    assert.equal(drawn(rowNamed(page, 'Builder')!), before, 'renaming the profile changed its organism');

    assert.equal((await call(d, 'PATCH', `/profiles/${dev.id}`, { model: 'claude-opus-5' })).status, 200);
    await pollUntil(page, () => one(rowNamed(page, 'Builder')!, 'tier')!.textContent === 'claude-opus-5', 'the new model on the row');
    const after = drawn(rowNamed(page, 'Builder')!);
    assert.match(after, /model tier opus/);
    // The cells, not only the label: a label that follows the model over an
    // unchanged shape would be a new name on the same organism.
    assert.notEqual(cells(rowNamed(page, 'Builder')!), before.split(' ').pop(), 'changing the model did not change the drawn cells');
    assert.equal(cells(rowNamed(page, 'Builder')!), generated(`mg.v1:${dev.id}`, 'claude-opus-5'));
  });
});

// ------------------------------------------------------ acceptance 4 ----

test('the add form offers the daemon\'s models, creates a profile that appears on the next read, and shows a duplicate name\'s refusal in the daemon\'s own words', async () => {
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    const models = (await call(d, 'GET', '/models')).json as string[];
    await page.waitFor(() => page.byId('profileModel').children.length === models.length, 'the model select to fill');
    assert.deepEqual(page.byId('profileModel').children.map((o) => o.value), models);

    page.byId('profileName').value = 'Designer';
    page.byId('profileModel').value = models[models.length - 1];
    page.byId('profilePurpose').value = 'Draws the screens.';
    page.byId('addProfile').click();
    await page.waitFor(() => rowNamed(page, 'Designer') !== null, 'the new profile on the roster');
    const made = (await profiles(d)).find((p) => p.name === 'Designer');
    assert.ok(made, 'the row is on the page but not in the daemon');
    assert.equal(made!.model, models[models.length - 1]);
    assert.equal(one(rowNamed(page, 'Designer')!, 'purpose')!.textContent, 'Draws the screens.');
    assert.equal(page.text('fleetCount'), '7 profiles');
    assert.equal(page.byId('profileName').value, '', 'the form kept the old name after a success');
    assert.equal(page.byId('profileError').hidden, true);

    page.byId('profileName').value = 'developer';
    page.byId('profilePurpose').value = 'A second one.';
    page.byId('addProfile').click();
    await page.waitFor(() => !page.byId('profileError').hidden, 'the refusal to show');
    const refusal = await call(d, 'POST', '/profiles', { name: 'developer', model: models[0], purpose: 'A second one.' });
    assert.equal(refusal.status, 400);
    assert.equal(page.text('profileError'), refusal.json.error, 'the page reworded the daemon\'s sentence');
    assert.equal(rows(page).length, 7, 'a refused profile reached the roster');
  });
});

// ---------------------------------------------- the roster is global ----

test('with profiles and no project at all, the roster still shows them and the add form still has its models', async () => {
  // Review finding (Medium): the roster was read only inside the per-project
  // refresh, so a daemon with no project drew nothing and a profile could not
  // be added. A real `magarine serve` on a fresh state directory: six seeded
  // profiles, zero projects.
  await withDaemon(root, async (d) => {
    const page = openPage({ baseUrl: d.baseUrl, token: d.token });
    await page.waitFor(() => rows(page).length === 6, 'six roster rows with no project');
    assert.equal(page.byId('projectSelect').children.length, 0, 'this daemon was meant to have no project');
    assert.equal(page.text('fleetCount'), '6 profiles');
    await page.waitFor(() => page.byId('profileModel').children.length > 0, 'the model select to fill with no project');

    page.byId('profileName').value = 'Solo';
    page.byId('profilePurpose').value = 'Works alone.';
    page.byId('addProfile').click();
    await page.waitFor(() => rowNamed(page, 'Solo') !== null, 'a profile added with no project');
  });
});

test('a model list the daemon fails to give is said, in its own words, under the empty select', async () => {
  // The daemon's /models is a constant, so the harness's named `refuse` answers
  // it with a 500 instead; the page's failure branch is what runs.
  await withScriptedDaemon(root, async (d) => {
    const sentence = 'the model table could not be read';
    const page = openPage({ baseUrl: d.baseUrl, token: d.token, refuse: { path: '/models', status: 500, error: sentence } });
    await page.waitFor(() => !page.byId('modelsError').hidden, 'the models error to show');
    assert.equal(page.text('modelsError'), sentence, 'the page reworded the daemon\'s sentence');
    assert.equal(page.byId('profileModel').children.length, 0);
  });
});

// ------------------------------------- the organism follows the roster ----

test('a profile moved to another tier redraws its ticket\'s organism in Needs you, with nothing about the ticket itself changing', async () => {
  await withScriptedDaemon(root, async (d) => {
    const t = profileTicket(d, 'Developer', 'Ask the owner');
    d.adapter.setScript(t.id, { kind: 'needs_user_decision' });
    await d.step();
    await d.waitForStatus(t.id, ['BLOCKED'], 'the Developer ticket asking');
    const dev = (await profiles(d)).find((p) => p.name === 'Developer')!;

    const page = await open(d);
    const askOrg = () => page.byId('needsList').querySelectorAll('span').find((n) => n.getAttribute('role') === 'img') ?? null;
    await pollUntil(page, () => askOrg() !== null, 'the Needs-you item');
    assert.equal(askOrg()!.getAttribute('aria-label'), 'agent organism, model tier sonnet');
    assert.match(page.text('needsList'), /^Developer · /, 'the item is not named by its profile');

    assert.equal((await call(d, 'PATCH', `/profiles/${dev.id}`, { model: 'claude-opus-5' })).status, 200);
    await pollUntil(page, () => one(rowNamed(page, 'Developer')!, 'tier')!.textContent === 'claude-opus-5', 'the roster to see the new model');
    await page.poll();
    assert.equal(askOrg()!.getAttribute('aria-label'), 'agent organism, model tier opus',
      'the Needs-you organism kept the old tier after the profile moved');
  });
});

// ------------------------------------------------------ acceptance 5 ----

test('the first Retire press hands focus to Keep, never to the confirm, so pressing again does not retire', async () => {
  // Review finding (Medium). reconcileList carries focus to the rebuilt row's
  // control in the same place, so this is decided by the row's control order.
  // The harness models focus as document.activeElement and nothing more:
  // enough to see WHICH control the carried focus lands on. Real keypresses in
  // Chrome are browser.test.ts's.
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    await pollUntil(page, () => rowNamed(page, 'Scribe') !== null, 'the Scribe row');
    const ask = buttonLabelled(rowNamed(page, 'Scribe')!, 'Retire Scribe');
    ask.focus();
    ask.click();                                                   // the first press
    const focused = page.document.activeElement!;
    assert.equal(focused.textContent, 'Keep', `focus landed on "${focused.getAttribute('aria-label') ?? focused.textContent}"`);

    focused.click();                                               // the second press, wherever focus is
    await page.settle();
    assert.ok((await profiles(d)).some((p) => p.name === 'Scribe'), 'pressing twice retired the profile');
    assert.equal(page.document.activeElement!.getAttribute('aria-label'), 'Retire Scribe', 'Keep did not hand focus back to Retire');
  });
});


test('retiring a profile takes a confirm, removes its row, and leaves its tickets\' cards readable', async () => {
  await withScriptedDaemon(root, async (d) => {
    const t = profileTicket(d, 'Scribe', 'Tidy the README');
    const page = await open(d);
    await pollUntil(page, () => rowNamed(page, 'Scribe') !== null && page.text('lanes').includes('Tidy the README'), 'the Scribe row and its card');
    assert.match(page.text('lanes'), /Scribe/, 'the card does not name its profile');

    buttonLabelled(rowNamed(page, 'Scribe')!, 'Retire Scribe').click();
    const asking = rowNamed(page, 'Scribe')!;
    assert.match(asking.textContent, /Retire Scribe\? This cannot be undone from this page\./);
    assert.ok((await profiles(d)).some((p) => p.name === 'Scribe'), 'the first press retired it -- there was no confirm step');

    buttonLabelled(asking, 'Keep').click();
    assert.doesNotMatch(rowNamed(page, 'Scribe')!.textContent, /cannot be undone/, 'Keep did not put the row back');

    buttonLabelled(rowNamed(page, 'Scribe')!, 'Retire Scribe').click();
    buttonLabelled(rowNamed(page, 'Scribe')!, 'Confirm: retire Scribe').click();
    await page.waitFor(() => rowNamed(page, 'Scribe') === null, 'the Scribe row to go');
    assert.ok(!(await profiles(d)).some((p) => p.name === 'Scribe'), 'the daemon still lists Scribe');
    assert.equal(page.text('fleetCount'), '5 profiles');

    await page.poll();
    const card = page.byId('lanes').querySelectorAll('[data-org-for]').find((o) => o.getAttribute('data-org-for') === t.id);
    assert.ok(card, 'the retired profile\'s ticket lost its card');
    assert.match(page.text('lanes'), /Tidy the README/);
    assert.match(page.text('lanes'), /Scribe/, 'the card no longer names its (retired) profile');
  });
});

// ------------------------------------------------------ acceptance 6 ----

test('a running ticket with no profile still appears, by tier and model, under one line', async () => {
  await withScriptedDaemon(root, async (d) => {
    const t = d.addWorkTicket({ title: 'Hand made' });
    d.adapter.setScript(t.id, { kind: 'hang' });
    await d.tickOnly();
    await d.waitForStatus(t.id, ['IN_PROGRESS'], 'the profile-less ticket running');

    const page = await open(d);
    await pollUntil(page, () => page.text('fleetList').includes('Running, not on the roster'), 'the not-on-the-roster line');
    const board = (await call(d, 'GET', `/board?project=${d.projectId}`)).json;
    assert.equal(board.tickets.find((x: any) => x.id === t.id).profile, null, 'the daemon gave this ticket a profile');
    const project = (await call(d, 'GET', '/projects')).json.find((p: any) => p.id === d.projectId);

    const loose = rows(page).find((r) => !one(r, 'retire'))!;
    assert.ok(loose, 'no row for the profile-less ticket');
    assert.equal(one(loose, 'tier')!.textContent, project.defaultModel);
    assert.match(one(loose, 'name')!.textContent, /^(fable|opus|sonnet|haiku|unknown)$/, 'the row is not named by its tier');
    assert.equal(rows(page).length, 7, 'six profiles and the one hand-made ticket');
    assert.equal(page.text('fleetCount'), '6 profiles', 'the hand-made ticket was counted as a profile');
  });
});

test('a card shows its profile\'s name and reason, and a profile-less card is unchanged', async () => {
  await withScriptedDaemon(root, async (d) => {
    const t = profileTicket(d, 'Reviewer', 'Read the diff');
    d.db.prepare('UPDATE tickets SET profile_reason = ? WHERE id = ?').run('reads and judges without writing code', t.id);
    d.addWorkTicket({ title: 'No profile here' });
    const page = await open(d);
    await pollUntil(page, () => page.text('lanes').includes('No profile here'), 'both cards');

    const cards = byClass(page.byId('lanes'), 'ticket');
    const withProfile = cards.find((c) => c.textContent.includes('Read the diff'))!;
    const without = cards.find((c) => c.textContent.includes('No profile here'))!;
    assert.equal(one(withProfile, 'profile')!.textContent, 'Reviewer');
    const why = withProfile.querySelector('[data-role="profile-reason"]');
    assert.ok(why, 'the card carries no profile reason');
    assert.equal(why!.textContent, 'Why this profilereads and judges without writing code');
    assert.equal(one(without, 'profile'), null);
    assert.equal(without.querySelector('[data-role="profile-reason"]'), null);
    // The profiled card's organism is the profile's own, the one on its roster row.
    const reviewer = (await profiles(d)).find((p) => p.name === 'Reviewer')!;
    assert.equal(one(withProfile, 'org')!.getAttribute('aria-label'), `agent organism, model tier ${reviewer.model.includes('sonnet') ? 'sonnet' : 'unknown'}`);
  });
});

// ------------------------------------------------------ acceptance 7 ----

test('ELEMENT-FIELD-TABLE.md has a row for every element the roster draws, and every roster sentence the page writes', () => {
  const table = readFileSync(join(UI_DIR, 'ELEMENT-FIELD-TABLE.md'), 'utf8');
  const app = readFileSync(join(UI_DIR, 'app.js'), 'utf8');
  for (const route of ['`GET /profiles`', '`POST /profiles`', '`POST /profiles/{id}/retire`', '`GET /models`']) {
    assert.ok(table.includes(`| ${route} |`), `the routes list does not name ${route}`);
  }
  for (const element of ['heading "Roster"', 'roster count', 'profile row: organism shape', 'profile row: name',
    'profile row: model', 'profile row: purpose', 'profile row: "idle"', 'profile row: "working', 'profile row: activity line',
    'profile row: "Retire"', 'retire confirm', 'retire error', 'Manager row', 'empty roster', 'roster read failure',
    'model select', 'error line', 'card profile name', 'card "Why this profile', 'who: profile name']) {
    assert.ok(table.includes(`| ${element}`), `the table has no row for "${element}"`);
  }
  // Copy the page writes must be copy the table lists, word for word.
  for (const copy of ['Running, not on the roster', 'no profiles \\u2014 add one below', 'This cannot be undone from this page.', 'Why this profile']) {
    assert.ok(app.includes(copy), `app.js no longer writes "${copy}" -- update this test and the table together`);
    const shown = copy.replace('\\u2014', '—');
    assert.ok(table.includes(shown), `the page writes "${shown}" and the table does not list it`);
  }
  // Ruling 38: no percentage and no completion bar. Stated in the table, and
  // the page draws neither (acceptance 2 checks the DOM).
  assert.match(table, /no percentage and no completion bar/);
});
