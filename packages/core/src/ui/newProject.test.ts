// BATCH 20B, RULING 42: the New project form. Every test runs the real page
// (ui/app.js) against a real in-process daemon over loopback; the adapter is
// the fake, pinned by scriptedDaemon.ts, so nothing here can reach the
// owner's real Claude.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot } from '../testSupport.ts';
import { setProjectScopePath } from '../store.ts';
import { withScriptedDaemon, type ScriptedDaemon } from './scriptedDaemon.ts';
import { openPage, type PageOptions } from './domHarness.ts';
import { UI_DIR } from './page.ts';

const root = testTempRoot('ui-new-project');
after(root.cleanup);

type OpenedPage = ReturnType<typeof openPage>;

async function open(d: ScriptedDaemon, extra: Partial<PageOptions> = {}): Promise<OpenedPage> {
  const page = openPage({ baseUrl: d.baseUrl, token: d.token, ...extra });
  await page.waitFor(() => page.byId('projectSelect').children.length === 1, 'the project to reach the selector');
  return page;
}

async function call(d: ScriptedDaemon, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${d.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${d.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const freshDir = (label: string): string => mkdtempSync(join(root.root, `${label}-`));

function type(page: OpenedPage, f: { name?: string; dir?: string; description?: string; scope?: string; cap?: string }): void {
  if (f.name !== undefined) page.byId('npName').value = f.name;
  if (f.dir !== undefined) page.byId('npDir').value = f.dir;
  if (f.description !== undefined) page.byId('npDescription').value = f.description;
  if (f.scope !== undefined) page.byId('npScope').value = f.scope;
  if (f.cap !== undefined) page.byId('npCap').value = f.cap;
}

async function openForm(page: OpenedPage): Promise<void> {
  page.byId('newProjectToggle').click();
  await page.settle();
  assert.equal(page.byId('newProject').hidden, false, 'the New project control did not open the form');
}

const fields = (page: OpenedPage) => ['npName', 'npDir', 'npDescription', 'npScope', 'npCap'].map((id) => page.byId(id).value);

test('the control is there beside the selector once signed in, and not at the gate', async () => {
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    assert.equal(page.byId('newProjectToggle').hidden, false);
    const signedOut = openPage({ baseUrl: d.baseUrl, token: null });
    await signedOut.settle();
    assert.equal(signedOut.byId('newProjectToggle').hidden, true, 'the control is offered with no token');
    // A token the daemon refuses puts the gate up over a page that had been signed in.
    const refused = openPage({ baseUrl: d.baseUrl, token: 'not-the-token' });
    await refused.waitFor(() => !refused.byId('gate').hidden, 'the gate after a refused token');
    assert.equal(refused.byId('newProjectToggle').hidden, true, 'the control stayed on the gate');
    assert.equal(refused.byId('newProject').hidden, true);
  });
});

test('creating a project selects it, writes the scope, empties the form and shows the daemon\'s scope note', async () => {
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    await openForm(page);
    const dir = freshDir('fresh');
    type(page, { name: 'Recipes', dir: ` ${dir} `, description: 'a cookbook', scope: '# Recipes\n\nKeep them.', cap: '2' });
    page.byId('npCreate').click();
    await page.waitFor(() => !page.byId('npDone').hidden, 'the success line');
    const list = (await call(d, 'GET', '/projects')).json;
    const row = list.find((p: any) => p.name === 'Recipes');
    assert.ok(row, 'the project is not in GET /projects');
    await page.waitFor(() => page.byId('projectSelect').value === row.id, 'the new project to be selected');
    assert.equal(page.text('projectId'), row.id);
    assert.equal(readFileSync(join(dir, 'SCOPE.md'), 'utf8'), '# Recipes\n\nKeep them.');
    assert.deepEqual(fields(page), ['', '', '', '', ''], 'a created project left its text in the form');
    assert.notEqual(page.text('npDoneNote'), '');
    assert.equal(page.byId('npForm').hidden, true);
    assert.equal(page.byId('npError').hidden, true);
  });
});

test('every refusal shows the daemon\'s own sentence verbatim and clears nothing', async () => {
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    await openForm(page);
    const taken = freshDir('taken');
    assert.equal((await call(d, 'POST', '/projects', { name: 'Taken', dir: taken })).status, 201);
    const withScope = freshDir('has-scope');
    writeFileSync(join(withScope, 'SCOPE.md'), 'the owner\'s own words');
    const cases: { form: Parameters<typeof type>[1]; api: Record<string, unknown> }[] = [
      { form: { name: 'A', dir: join(root.root, 'no-such-folder') }, api: { name: 'A', dir: join(root.root, 'no-such-folder') } },
      { form: { name: 'B', dir: taken }, api: { name: 'B', dir: taken } },
      { form: { name: 'C', dir: withScope, scope: '# new' }, api: { name: 'C', dir: withScope, scopeText: '# new' } },
      { form: { name: 'D', dir: freshDir('cap'), cap: 'lots' }, api: { name: 'D', dir: '', maxParallel: 'lots' } },
    ];
    for (const c of cases) {
      type(page, { description: '', scope: '', cap: '', ...c.form });
      const before = fields(page);
      page.byId('npCreate').click();
      await page.waitFor(() => !page.byId('npError').hidden, 'a refusal');
      const asked = { ...c.api, dir: c.api.dir || c.form.dir };
      const sentence = (await call(d, 'POST', '/projects', asked)).json.error;
      assert.equal(typeof sentence, 'string');
      assert.equal(page.text('npError'), sentence, 'the page reworded or replaced the daemon\'s sentence');
      assert.deepEqual(fields(page), before, 'a refusal cleared what was typed');
      assert.equal(page.byId('npForm').hidden, false);
      assert.equal(page.byId('npCreate').disabled, false, 'the button stayed disabled after a refusal');
      page.byId('npError').hidden = true;
    }
    assert.equal(readFileSync(join(withScope, 'SCOPE.md'), 'utf8'), 'the owner\'s own words', 'an existing SCOPE.md was changed');
    assert.equal(existsSync(join(root.root, 'no-such-folder')), false, 'the daemon created a directory');
    const taker = (await call(d, 'POST', '/projects', { name: 'B', dir: taken })).json.error;
    assert.ok(taker.includes('Taken'), 'the duplicate-directory sentence no longer names the project');
  });
});

test('typing survives two polls: every field, the disclosure and a chosen model', async () => {
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    await openForm(page);
    page.byId('npModelsToggle').click();
    await page.waitFor(() => page.byId('npManagerModel').children.length > 1, 'the model choices');
    const models = (await call(d, 'GET', '/models')).json as string[];
    page.byId('npManagerModel').value = models[0];
    type(page, { name: 'half a na', dir: 'C:\\half\\a\\pa', description: 'des', scope: '# half a scope\n\nand', cap: '3-' });
    await page.poll();
    await page.poll();
    assert.deepEqual(fields(page), ['half a na', 'C:\\half\\a\\pa', 'des', '# half a scope\n\nand', '3-'], 'two polls threw the typing away');
    assert.equal(page.byId('npManagerModel').value, models[0], 'a poll reset the chosen model');
    assert.equal(page.byId('npModels').hidden, false, 'a poll closed the disclosure');
    assert.equal(page.byId('newProject').hidden, false, 'a poll closed the form');
    // Closing and reopening the form keeps the draft too.
    page.byId('npCancel').click();
    await openForm(page);
    assert.equal(page.byId('npName').value, 'half a na', 'closing the form threw the draft away');
  });
});

test('models and the cap sit under a disclosure that starts closed on "use the machine default"', async () => {
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    await openForm(page);
    assert.equal(page.byId('npModels').hidden, true);
    await page.waitFor(() => page.byId('npDefaultModel').children.length > 1, 'the model choices');
    for (const id of ['npDefaultModel', 'npManagerModel', 'npVerifierModel']) {
      assert.equal(page.byId(id).value, '');
      assert.equal(page.byId(id).children[0].textContent, 'use the machine default');
    }
    // Nothing chosen sends no model and no cap: the daemon applies its own.
    const dir = freshDir('defaults');
    type(page, { name: 'Plain', dir });
    page.byId('npCreate').click();
    await page.waitFor(() => !page.byId('npDone').hidden, 'the success line');
    const row = (await call(d, 'GET', '/projects')).json.find((p: any) => p.name === 'Plain');
    assert.equal(row.managerModel ?? null, null);
    assert.equal(row.verifierModel ?? null, null);
    assert.equal(row.maxParallelWorkers ?? null, null);
    // No starting scope typed: none is sent, so the daemon writes no file and says so.
    assert.equal(existsSync(join(dir, 'SCOPE.md')), false, 'a blank starting scope created a SCOPE.md');
  });
});

test('a double click creates one project and shows no refusal', async () => {
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    await openForm(page);
    type(page, { name: 'Twice', dir: freshDir('twice') });
    page.byId('npCreate').click();
    page.byId('npCreate').click();
    await page.waitFor(() => !page.byId('npDone').hidden, 'the success line');
    await page.settle();
    assert.equal(page.byId('npError').hidden, true, 'the second click was refused and shown');
    assert.equal((await call(d, 'GET', '/projects')).json.filter((p: any) => p.name === 'Twice').length, 1);
  });
});

test('the copy says the folder must exist, and that the starting scope is written only when there is no SCOPE.md', () => {
  const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
  assert.ok(html.includes('a folder that already exists on this computer. Magarine will not create it.'));
  assert.ok(html.includes('only if the folder has no SCOPE.md.'));
  assert.equal(/type="file"|webkitdirectory|showDirectoryPicker/.test(html + readFileSync(join(UI_DIR, 'app.js'), 'utf8')), false,
    'the page fakes a folder picker');
});

test('ELEMENT-FIELD-TABLE.md lists the route, every element ruling 42 adds and every sentence it writes', () => {
  const table = readFileSync(join(UI_DIR, 'ELEMENT-FIELD-TABLE.md'), 'utf8');
  const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
  assert.ok(table.includes('| `POST /projects` |'));
  for (const element of ['"New project" button', 'name input', 'directory input', 'description input', 'starting scope textarea',
    '"Models and worker cap" disclosure', 'default / Manager / verifier model selects', 'worker cap input', '"Create project" button',
    'refusal', 'success line', 'after a 201']) {
    assert.ok(table.includes(`| ${element}`), `the table has no row for "${element}"`);
  }
  for (const copy of ['Type the full path of a folder that already exists on this computer. Magarine will not create it.',
    'Written to SCOPE.md in that folder only if the folder has no SCOPE.md. If it already has one, the project is refused and nothing is created.']) {
    assert.ok(html.includes(copy) && table.includes(copy), `"${copy}" is not in both the page and the table`);
  }
});


test('after a create, an open Settings panel shows the NEW project and Save cannot write the old cap onto it', async () => {
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    const capOf = async (id: string) => (await call(d, 'GET', '/projects')).json.find((p: any) => p.id === id).maxParallelWorkers ?? null;
    assert.equal(await capOf(d.projectId), 2, 'the scripted project starts with a cap of 2');
    page.byId('settingsToggle').click();
    await page.settle();
    await page.waitFor(() => page.byId('projectCap').value === '2', 'Settings to show the first cap');
    await openForm(page);
    type(page, { name: 'Fresh', dir: freshDir('fresh') });
    page.byId('npCreate').click();
    await page.waitFor(() => !page.byId('npDone').hidden, 'the success line');
    const fresh = (await call(d, 'GET', '/projects')).json.find((p: any) => p.name === 'Fresh');
    await page.waitFor(() => page.byId('projectSelect').value === fresh.id, 'the new project to be selected');
    await page.waitFor(() => page.byId('projectCap').value === '', 'Settings to be refilled from the new project');
    assert.equal((page.byId('projectCapDefault') as any).checked, true);
    page.byId('saveProject').click();
    await page.settle();
    assert.equal(await capOf(fresh.id), null, 'Save wrote the old cap onto the new one');
    assert.equal(await capOf(d.projectId), 2, 'the first project changed');
  });
});

test('a create with an unsaved scope draft keeps the draft, stays put and offers a switch; with no draft it switches', async () => {
  await withScriptedDaemon(root, async (d) => {
    const dir = freshDir('scoped');
    const file = join(dir, 'SCOPE.md');
    writeFileSync(file, '# One\n');
    setProjectScopePath(d.db, d.projectId, file);
    const page = await open(d);
    await page.waitFor(() => page.text('scopeText').includes('One'), 'the scope text');
    page.byId('scopeToggle').click();
    page.byId('scopeEdit').click();
    page.byId('scopeDraft').value = '# One\n\nhalf a thought';
    await openForm(page);
    type(page, { name: 'Second', dir: freshDir('second') });
    page.byId('npCreate').click();
    await page.waitFor(() => !page.byId('npDone').hidden, 'the success line');
    await page.settle();
    const second = (await call(d, 'GET', '/projects')).json.find((p: any) => p.name === 'Second');
    assert.ok(second, 'the project was not created');
    assert.equal(page.byId('projectSelect').value, d.projectId, 'the page switched away from an unsaved draft');
    assert.equal(page.byId('scopeEditor').hidden, false, 'the draft editor was closed');
    assert.equal(page.byId('scopeDraft').value, '# One\n\nhalf a thought', 'the draft was lost');
    assert.match(page.text('npDoneNote'), /unsaved scope draft here was kept/);
    assert.equal(page.byId('npDoneSwitch').hidden, false, 'no switch control was offered');
    page.byId('npDoneSwitch').click();
    await page.waitFor(() => page.byId('projectSelect').value === second.id, 'the switch to the new project');

    // No draft: a plain create switches, as before.
    await openForm(page);
    type(page, { name: 'Third', dir: freshDir('third') });
    page.byId('npCreate').click();
    await page.waitFor(() => !page.byId('npDone').hidden, 'the second success line');
    const third = (await call(d, 'GET', '/projects')).json.find((p: any) => p.name === 'Third');
    await page.waitFor(() => page.byId('projectSelect').value === third.id, 'the new project to be selected');
    assert.equal(page.byId('npDoneSwitch').hidden, true);
  });
});

test('the cap is sent as typed: "0x2" is refused by the daemon, not read as 2', async () => {
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    await openForm(page);
    const dir = freshDir('hex');
    type(page, { name: 'Hex', dir, cap: '0x2' });
    page.byId('npCreate').click();
    await page.waitFor(() => !page.byId('npError').hidden, 'the refusal');
    const list = (await call(d, 'GET', '/projects')).json;
    assert.equal(list.some((p: any) => p.name === 'Hex'), false, 'a project was created with a reinterpreted cap');
    assert.equal(page.byId('npCap').value, '0x2');
  });
});

test('Escape and Cancel close the panel and put focus back on the control that opened it', async () => {
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    const press = (key: string) => { for (const fn of page.document.listeners.get('keydown') ?? []) fn({ key }); };
    const toggle = page.byId('newProjectToggle');

    await openForm(page);
    assert.equal(page.document.activeElement, page.byId('npName'), 'opening did not focus the first field');
    type(page, { name: 'half typed' });
    press('Escape');
    assert.equal(page.byId('newProject').hidden, true, 'Escape did not close the panel');
    assert.equal(page.document.activeElement, toggle, 'Escape did not return focus to the control');
    assert.equal(toggle.attributes.get('aria-expanded'), 'false');

    await openForm(page);
    page.byId('npCancel').click();
    assert.equal(page.byId('newProject').hidden, true);
    assert.equal(page.document.activeElement, toggle, 'Cancel did not return focus to the control');

    // Escape with the panel closed does nothing to focus.
    page.byId('npName').focus();
    press('Escape');
    assert.equal(page.document.activeElement, page.byId('npName'), 'Escape moved focus with nothing open');
  });
});

test('a cap that only reads as a number is refused by the daemon, in the form and in Settings', async () => {
  await withScriptedDaemon(root, async (d) => {
    const page = await open(d);
    await openForm(page);
    for (const bad of ['0x2', '1e1', ' 3x', '02', '+3']) {
      type(page, { name: 'Odd', dir: freshDir('odd'), cap: bad });
      page.byId('npCreate').click();
      await page.waitFor(() => !page.byId('npError').hidden, `a refusal of "${bad}"`);
      page.byId('npError').hidden = true;
    }
    assert.equal((await call(d, 'GET', '/projects')).json.some((p: any) => p.name === 'Odd'), false, 'a reinterpreted cap created a project');

    page.byId('settingsToggle').click();
    await page.settle();
    for (const bad of ['0x2', '1e1', '02']) {
      page.byId('projectCap').value = bad;
      (page.byId('projectCapDefault') as any).checked = false;
      page.byId('saveProject').click();
      await page.waitFor(() => !page.byId('projectError').hidden, `the Settings refusal of "${bad}"`);
      page.byId('projectError').hidden = true;
      const row = (await call(d, 'GET', '/projects')).json.find((p: any) => p.id === d.projectId);
      assert.equal(row.maxParallelWorkers, 2, `"${bad}" changed the saved cap`);
    }
  });
});
