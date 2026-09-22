// THE TWO PROOFS THAT NEED A REAL BROWSER. Ruling 26 condition 4.
//
// Everything else about the page is asserted either from its source or through
// src/ui/domHarness.ts, which has no rendering, no layout and no animation.
// These two claims cannot be made there at all:
//
//   1. RULING 18 REQUIREMENT 4 -- the organism's animation SURVIVES the
//      re-render that a progress event itself causes. It was proven in batch 15
//      by a throwaway script in `.shots/` and by nothing in the suite. The
//      re-render is real, the stream is real (Chrome has EventSource-shaped
//      streaming fetch; Node does not), and the animation is real.
//   2. `aria-current` is actually DRAWN. The page set the attribute for a whole
//      batch while no rule in the skin painted it: every test passed and all
//      three nav entries looked identical. A source test cannot see that; a
//      browser can.
//
// WHAT THIS FILE MAY CLAIM: what a real browser did, on one machine, on one
// run. When Chrome is absent it is ONE named skip carrying its reason, and the
// batch's RESULT.md must quote the suite summary line (ruling 26 item 5): a
// green suite with this file skipped is not a closing condition.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot } from '../testSupport.ts';
import { withDaemon, runCli } from './testDaemon.ts';
import { launchBrowser, resolveChrome, CHROME_ABSENT_REASON } from './browserHarness.ts';

const root = testTempRoot('ui-browser');
after(root.cleanup);

const chrome = resolveChrome();

if (!chrome) {
  test('the browser proofs need Chrome, and it was not found', { skip: CHROME_ABSENT_REASON }, () => {});
} else {

test('Chrome was resolved, and the run says by which strategy', (t) => {
  // The Orchestrator quotes this in the batch's RESULT.md beside the suite
  // summary line. Precedent: claudeCli reports `resolved via
  // windows_shim_native_exe` for the same reason -- when a future machine
  // resolves differently, the record says which path was taken instead of
  // leaving the next person to guess.
  assert.ok(chrome, 'this branch only runs when Chrome was found');
  assert.ok(['magarine_chrome_env', 'path', 'platform_install_path'].includes(chrome.strategy),
    `unnamed Chrome resolution strategy: ${chrome.strategy}`);
  t.diagnostic(`chrome resolved via ${chrome.strategy}: ${chrome.executable}`);
});

test('aria-current on the current view is actually drawn, not only announced', async () => {
  // The defect this exists for: app.js set aria-current="page" and the shipped
  // skin had no rule for it, so the current view was invisible while every
  // test passed. The claim is about PAINT, so it is asked of the browser:
  // the current entry must not look like the other two.
  await withDaemon(root, async (d) => {
    await d.createProject('Alpha');
    const browser = await launchBrowser(chrome.executable, mkdtempSync(join(root.root, 'chrome-')));
    try {
      await browser.openPage(d.baseUrl, d.token, '#needs-you');

      const nav = await browser.cdp.eval<{ href: string; current: string | null; bg: string; fg: string }[]>(`
        [...document.querySelectorAll('nav[aria-label="Views"] a')].map((a) => {
          const cs = getComputedStyle(a);
          return { href: a.getAttribute('href'), current: a.getAttribute('aria-current'),
                   bg: cs.backgroundColor, fg: cs.color };
        })`);

      assert.equal(nav.length, 3, 'the three view links are not all there');
      const currents = nav.filter((a) => a.current === 'page');
      assert.deepEqual(currents.map((a) => a.href), ['#needs-you'],
        'the state is wrong before paint is even asked about');

      const others = nav.filter((a) => a.current !== 'page');
      for (const other of others) {
        assert.notEqual(currents[0].bg, other.bg,
          `the current view is painted exactly like ${other.href}: the attribute is set and nothing draws it`);
        assert.notEqual(currents[0].fg, other.fg,
          `the current view's text is painted exactly like ${other.href}'s`);
      }
      // Both channels differ, which is the whole claim this file can honestly
      // make: the current view is DRAWN. WHICH colours they are is deliberately
      // not asserted here -- an earlier version of this test guessed that the
      // current background would equal the other entries' text colour, and the
      // browser said otherwise: the nav's normal text is the muted token, not
      // the plain foreground. That is the palette's business, and every pair of
      // it is checked for contrast in src/ui/contrast.test.ts, computed rather
      // than eyeballed.
      assert.ok(others.every((o) => o.bg === others[0].bg),
        'the two non-current entries are painted differently from each other, which is not a state the page has');
    } finally {
      await browser.close();
    }
  });
});

test('ruling 18 requirement 4: the organism keeps animating across the re-render its own progress event causes', async () => {
  // A real daemon, a real scripted burst (Role A item 1), a real event stream
  // and a real animation. Each progress event makes the page re-read the board
  // and rebuild every card -- so the node that is animating is replaced
  // mid-pass, and app.js's resumeMotion has to carry the pass onto the new one.
  const workspace = mkdtempSync(join(root.root, 'work-'));
  const stateDir = mkdtempSync(join(root.root, 'burst-'));
  const project = JSON.parse((await runCli(
    ['project', 'create', '--name', 'Burst', '--max-parallel', '2', '--dir', workspace, '--state-dir', stateDir, '--json'])).stdout) as { id: string };
  const add = async (title: string) => JSON.parse((await runCli(
    ['ticket', 'add', '--project', project.id, '--title', title, '--state-dir', stateDir, '--json'])).stdout) as { id: string };

  // TWO tickets, because one cannot show this. A ticket's OWN progress event
  // replaces its card and then arms the new node, in that order -- so the
  // replacement never lands inside its own pass. The re-render that has to be
  // survived is the one caused by SOMETHING ELSE: here, a second ticket
  // reporting every 300ms while the first is mid-animation. That is also what
  // really happens on the owner's board, where several workers run at once.
  const watched = await add('the ticket being watched');
  const chatty = await add('a chatty neighbour');

  // Both report throughout, 500ms apart, for far longer than the page takes to
  // load -- so the burst is LIVE while it is being watched, arriving over the
  // real event stream rather than being flushed as history at first connect.
  const burst: string[] = [];
  for (let i = 0; i < 30; i++) burst.push('--fake-script', `${watched.id}=progress:thinking it over ${i + 1}`);
  for (let i = 0; i < 30; i++) burst.push('--fake-script', `${chatty.id}=progress:step ${i + 1}`);

  await withDaemonAt(stateDir, ['--max-parallel', '2', '--fake-progress-gap', '500', ...burst], async (d) => {
    const browser = await launchBrowser(chrome.executable, mkdtempSync(join(root.root, 'chrome-')));
    try {
      await browser.openPage(d.baseUrl, d.token);

      // Sample the organism on every animation frame: which node is there (an
      // identity stamp this sampler writes), whether it is armed, how far its
      // cells have run, and how many steps were armed.
      await browser.cdp.eval(`(() => {
        let stamp = 0; window.__samples = [];
        const t0 = performance.now();
        (function frame() {
          const n = document.querySelector('[data-org-for=${JSON.stringify(watched.id)}]');
          if (n) {
            if (!n.__stamp) n.__stamp = ++stamp;
            const anims = n.getAnimations({ subtree: true });
            let max = null;
            for (const a of anims) if (a.currentTime !== null) max = Math.max(max === null ? 0 : max, a.currentTime);
            window.__samples.push({ t: Math.round(performance.now() - t0), node: n.__stamp,
              tick: n.getAttribute('data-tick'), cur: max === null ? null : Math.round(max) });
          }
          requestAnimationFrame(frame);
        })();
        return true;
      })()`);

      await new Promise((r) => setTimeout(r, 9000));
      const samples = await browser.cdp.eval<{ t: number; node: number; tick: string | null; cur: number | null }[]>(
        'window.__samples');

      const armed = samples.filter((s) => s.tick !== null);
      assert.ok(armed.length > 0,
        'the organism never animated at all during a real scripted burst -- the live path is dead');

      // THE CLAIM, and why it is this one. A re-render replaces the animating
      // node; the question is whether the new node is still animating. What is
      // NOT asserted is that currentTime carries on across every replacement:
      // this ticket reports repeatedly, so a replacement caused by its OWN next
      // event legitimately starts a NEW pass at zero, and the sampler cannot
      // tell that apart from a destroyed one. Being ARMED afterwards can tell
      // them apart -- with resumeMotion disabled the replacement node carries
      // no data-tick and no animations at all, which is what the batch 15
      // control run showed and what the control for this test shows again.
      let replacedWhileArmed = 0;
      const wentDark: string[] = [];
      for (let i = 1; i < samples.length; i++) {
        const prev = samples[i - 1];
        const s = samples[i];
        if (!prev.tick || s.node === prev.node) continue;
        replacedWhileArmed++;
        if (s.tick === null || s.cur === null) wentDark.push(`at ${s.t}ms node ${prev.node} -> ${s.node}`);
      }
      assert.ok(replacedWhileArmed > 0,
        'no re-render landed inside an animation, so this run proves nothing about surviving one');
      assert.deepEqual(wentDark, [],
        `a re-render left the organism unarmed instead of carrying its pass on: ${wentDark.join('; ')}`);
    } finally {
      await browser.close();
    }
  });
});


// ------------------------------------------- batch 17 item 4: the launch code, in a real browser
//
// The DOM harness proves the page's script; only a browser can say what the
// ADDRESS BAR holds and what a person sees when they open a spent link. The
// code is minted against the real daemon through the real route.

test('a launch code signs a real browser in, leaves no code in the address, and a second load of the same code reaches the gate', async () => {
  await withDaemon(root, async (d) => {
    await d.createProject('Alpha');
    const mint = await fetch(`${d.baseUrl}/launch-code`, {
      method: 'POST', headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(mint.status, 200, 'the daemon would not mint a launch code');
    const { code } = (await mint.json()) as { code: string };
    const browser = await launchBrowser(chrome.executable, mkdtempSync(join(root.root, 'chrome-')));
    const until = async (expr: string, what: string) => {
      for (let i = 0; i < 100; i++) {
        if (await browser.cdp.eval<boolean>(expr)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`the browser never reached: ${what}`);
    };
    try {
      // FIRST LOAD: no token anywhere, only the code in the fragment.
      await browser.cdp.send('Page.navigate', { url: `${d.baseUrl}/#launch=${code}` });
      await until(`document.querySelectorAll('#projectSelect option').length === 1`, 'the board, with its project');
      const first = await browser.cdp.eval<{ href: string; gate: boolean; board: boolean; stored: string | null }>(`({
        href: location.href, gate: document.getElementById('gate').hidden,
        board: !document.getElementById('board').hidden, stored: sessionStorage.getItem('magarine.token') })`);
      assert.equal(first.gate, true, 'the gate is showing after a good launch code');
      assert.equal(first.board, true, 'the board is not shown after a good launch code');
      assert.equal(first.stored, d.token, 'the exchanged token is not the daemon\'s');
      assert.ok(!first.href.includes(code) && !first.href.includes('launch'), `the code survived in the address: ${first.href}`);
      assert.equal(first.href, `${d.baseUrl}/#board`);

      // SECOND LOAD: the same code, as from a bookmark or a re-opened window.
      // A window would start with empty sessionStorage; it is cleared here to
      // say so, and the tab goes through about:blank because a same-document
      // navigation between two fragments would not run the page again.
      await browser.cdp.eval(`sessionStorage.clear()`);
      await browser.cdp.send('Page.navigate', { url: 'about:blank' });
      await browser.cdp.send('Page.navigate', { url: `${d.baseUrl}/#launch=${code}` });
      await until(`!document.getElementById('gate').hidden`, 'the gate, for a spent code');
      const second = await browser.cdp.eval<{ href: string; notice: string; board: boolean; stored: string | null }>(`({
        href: location.href, notice: document.getElementById('notice-auth').textContent,
        board: !document.getElementById('board').hidden, stored: sessionStorage.getItem('magarine.token') })`);
      assert.equal(second.notice, 'this launch link has expired -- run `magarine app` again, or `magarine token` and paste it here');
      assert.equal(second.board, false, 'a spent code showed the board');
      assert.equal(second.stored, null, 'a spent code left a token behind');
      assert.ok(!second.href.includes(code), `the spent code sits in the address: ${second.href}`);
    } finally {
      await browser.close();
    }
  });
});


// ------------------------------------------- never rebuild an input under a user's hands
//
// The owner typed an answer into a Needs You box and the page threw it away a
// few seconds later: every poll rebuilt the list and nothing carried the
// draft, the focus or the caret across. Real daemon, real poll, real live
// events, real typing (Input.insertText goes through the browser's own editing
// path, as a keyboard does).

test('a Needs You answer box keeps its text, focus and caret across polls, live events and an unrelated ticket moving; and across a change to its own row', async () => {
  const workspace = mkdtempSync(join(root.root, 'work-'));
  const stateDir = mkdtempSync(join(root.root, 'typing-'));
  const project = JSON.parse((await runCli(
    ['project', 'create', '--name', 'Typing', '--max-parallel', '2', '--dir', workspace, '--state-dir', stateDir, '--json'])).stdout) as { id: string };
  const add = async (title: string) => JSON.parse((await runCli(
    ['ticket', 'add', '--project', project.id, '--title', title, '--state-dir', stateDir, '--json'])).stdout) as { id: string };
  const asking = await add('the ticket that asks');
  const chatty = await add('a chatty neighbour');
  const script: string[] = ['--fake-script', `${asking.id}=needs_user_decision`];
  for (let i = 0; i < 40; i++) script.push('--fake-script', `${chatty.id}=progress:step ${i + 1}`);

  await withDaemonAt(stateDir, ['--max-parallel', '2', '--fake-progress-gap', '500', ...script], async (d) => {
    const browser = await launchBrowser(chrome.executable, mkdtempSync(join(root.root, 'chrome-')));
    const until = async (expr: string, what: string) => {
      for (let i = 0; i < 150; i++) {
        if (await browser.cdp.eval<boolean>(expr)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`the browser never reached: ${what}`);
    };
    const probe = () => browser.cdp.eval<{ value: string; focused: boolean; start: number | null; end: number | null; stamp: number | null; boxes: number }>(`(() => {
      const boxes = document.querySelectorAll('#needsList .ask input.field');
      const b = boxes[0];
      return { value: b.value, focused: document.activeElement === b, start: b.selectionStart, end: b.selectionEnd,
               stamp: b.__stamp || null, boxes: boxes.length };
    })()`);
    try {
      await browser.openPage(d.baseUrl, d.token);
      // openPage's hash form is a same-document navigation and would not reload the page, so the view is chosen after it.
      await browser.cdp.eval(`location.hash = '#needs-you'`);
      await until(`document.querySelectorAll('#needsList .ask input.field').length === 1`, 'the answer box');

      // Stamp the node so "the same node" can be asked, then type like a person.
      await browser.cdp.eval(`(() => { const b = document.querySelector('#needsList .ask input.field'); b.__stamp = 7; b.focus(); return true; })()`);
      await browser.cdp.send('Input.insertText', { text: 'half an answer' });
      await browser.cdp.eval(`document.querySelector('#needsList .ask input.field').setSelectionRange(4, 4)`);

      // PART 1: several polls (4s each) and a stream of live events from the
      // chatty neighbour. Nothing about this row changes.
      await new Promise((r) => setTimeout(r, 14_000));
      const settled = await probe();
      assert.equal(settled.boxes, 1);
      assert.equal(settled.value, 'half an answer', 'a refresh threw the draft away');
      assert.equal(settled.focused, true, 'a refresh pulled focus out of the box');
      assert.deepEqual([settled.start, settled.end], [4, 4], 'a refresh moved the caret');
      assert.equal(settled.stamp, 7, 'the box was rebuilt although nothing about its row changed');

      // PART 2: the row's own data changes, so the row IS rebuilt, and the
      // owner's state has to be carried across. A blocked ticket's real row has
      // nothing that moves by itself, so the ONE thing faked here is the inbox
      // reply's text: the page's own fetch is wrapped, passes the real daemon's
      // answer through, and appends a suffix to each item's message when told.
      await browser.cdp.eval(`(() => {
        const real = window.fetch.bind(window);
        window.fetch = async (url, init) => {
          const res = await real(url, init);
          if (window.__suffix && String(url).includes('/inbox')) {
            const items = await res.clone().json();
            for (const i of items) i.message += window.__suffix;
            return new Response(JSON.stringify(items), { status: res.status, headers: { 'Content-Type': 'application/json' } });
          }
          return res;
        };
        window.__suffix = ' [edited]';
        return true;
      })()`);
      await until(`document.querySelector('#needsList .ask input.field') && document.querySelector('#needsList .ask input.field').__stamp !== 7`, 'the row to be rebuilt after its own data changed');
      const carried = await probe();
      assert.equal(carried.boxes, 1);
      assert.equal(carried.value, 'half an answer', 'the draft was lost when the row was rebuilt');
      assert.equal(carried.focused, true, 'focus was lost when the row was rebuilt');
      assert.deepEqual([carried.start, carried.end], [4, 4], 'the caret was lost when the row was rebuilt');
    } finally {
      await browser.close();
    }
  });
});

test('the Manager composer keeps its text, focus and caret across polls and live events', async () => {
  const workspace = mkdtempSync(join(root.root, 'work-'));
  const stateDir = mkdtempSync(join(root.root, 'composer-'));
  const project = JSON.parse((await runCli(
    ['project', 'create', '--name', 'Composer', '--max-parallel', '1', '--dir', workspace, '--state-dir', stateDir, '--json'])).stdout) as { id: string };
  const chatty = JSON.parse((await runCli(
    ['ticket', 'add', '--project', project.id, '--title', 'chatty', '--state-dir', stateDir, '--json'])).stdout) as { id: string };
  const script: string[] = [];
  for (let i = 0; i < 40; i++) script.push('--fake-script', `${chatty.id}=progress:step ${i + 1}`);

  await withDaemonAt(stateDir, ['--fake-progress-gap', '500', ...script], async (d) => {
    const browser = await launchBrowser(chrome.executable, mkdtempSync(join(root.root, 'chrome-')));
    try {
      await browser.openPage(d.baseUrl, d.token);
      await browser.cdp.eval(`location.hash = '#scope'`);
      await browser.cdp.eval(`(() => { const s = document.getElementById('say'); s.__stamp = 9; s.focus(); return true; })()`);
      await browser.cdp.send('Input.insertText', { text: 'a question for the Manager' });
      await browser.cdp.eval(`document.getElementById('say').setSelectionRange(6, 6)`);
      await new Promise((r) => setTimeout(r, 14_000));
      const after = await browser.cdp.eval<{ value: string; focused: boolean; start: number | null; end: number | null; stamp: number | null }>(`(() => {
        const s = document.getElementById('say');
        return { value: s.value, focused: document.activeElement === s, start: s.selectionStart, end: s.selectionEnd, stamp: s.__stamp || null };
      })()`);
      assert.equal(after.value, 'a question for the Manager', 'a refresh threw the composer draft away');
      assert.equal(after.focused, true, 'a refresh pulled focus out of the composer');
      assert.deepEqual([after.start, after.end], [6, 6], 'a refresh moved the composer caret');
      assert.equal(after.stamp, 9, 'the composer was rebuilt');
    } finally {
      await browser.close();
    }
  });
});


test('ruling 35: Chrome accepts the re-subset fonts and draws an arrow and a check mark from them', async () => {
  // The cmap parser proves what the files say; only a browser proves its font
  // sanitiser accepts them and that the unicode-range now sends these
  // characters to the bundled families instead of a system font.
  await withDaemon(root, async (d) => {
    await d.createProject('Glyphs');
    const browser = await launchBrowser(chrome.executable, mkdtempSync(join(root.root, 'chrome-')));
    try {
      await browser.openPage(d.baseUrl, d.token);
      const r = await browser.cdp.eval<{ sans: number; mono: number; states: string[] }>(`(async () => {
        const sans = await document.fonts.load('400 1rem "Magarine Sans"', '→ ✓');
        const mono = await document.fonts.load('400 1rem "JetBrains Mono"', '→ ✓');
        return { sans: sans.length, mono: mono.length, states: [...document.fonts].map((f) => f.family + ':' + f.status) };
      })()`);
      assert.equal(r.sans, 1, 'Chrome did not select the bundled sans for an arrow and a check mark');
      assert.equal(r.mono, 1, 'Chrome did not select the bundled mono for an arrow and a check mark');
      assert.ok(r.states.every((s) => s.endsWith(':loaded')), `a bundled font failed to load: ${r.states.join(', ')}`);
    } finally {
      await browser.close();
    }
  });
});


test('batch 18 item 4: on the Manager tab the conversation takes the height and the scope opens to full height on request', async () => {
  // Layout is only a browser's to say. The owner's words: "the scope height
  // panel is bothering, neither the scope is easily readable and neither the chat".
  await withDaemon(root, async (d) => {
    const dir = mkdtempSync(join(root.root, 'scope-'));
    writeFileSync(join(dir, 'SCOPE.md'), ['# Recipe box', ''].concat(
      Array.from({ length: 40 }, (_, i) => `- Requirement ${i + 1}: the app must handle case ${i + 1}.`)).join('\n'));
    const project = await d.createProject('Layout', ['--dir', dir]);
    for (const m of ['one', 'two', 'three']) {
      await runCli(['discuss', '--project', project.id, '--message', m, '--state-dir', d.stateDir]);
    }
    const browser = await launchBrowser(chrome.executable, mkdtempSync(join(root.root, 'chrome-')));
    const measure = () => browser.cdp.eval<{ h: number; scope: number; conv: number; composerBottom: number; list: number; open: boolean }>(`(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      return { h: innerHeight, scope: r('scope').height, conv: r('conversation').height,
               composerBottom: document.querySelector('#conversation .composer').getBoundingClientRect().bottom,
               list: r('convList').height, open: !document.getElementById('scopeBody').hidden };
    })()`);
    try {
      await browser.openPage(d.baseUrl, d.token);
      await browser.cdp.eval(`location.hash = '#scope'`);
      await new Promise((r) => setTimeout(r, 2500));

      const closed = await measure();
      assert.equal(closed.open, false, 'the scope ships open');
      assert.ok(closed.scope < 130, `the collapsed scope is still ${closed.scope}px tall`);
      assert.ok(closed.conv > closed.h * 0.6, `the conversation has only ${closed.conv}px of a ${closed.h}px window`);
      assert.ok(closed.composerBottom <= closed.h, 'the composer is below the fold');
      assert.ok(closed.list > 200, `the thread itself has only ${closed.list}px`);

      await browser.cdp.eval(`document.getElementById('scopeToggle').click()`);
      await new Promise((r) => setTimeout(r, 400));
      const open = await measure();
      assert.equal(open.open, true);
      assert.ok(open.scope > open.h * 0.5, `the open scope has only ${open.scope}px of a ${open.h}px window`);
      assert.ok(open.composerBottom <= open.h, 'opening the scope pushed the composer off the screen');
    } finally {
      await browser.close();
    }
  });
});

// Batch 19, ruling 38, review finding (Medium): retiring a profile takes two
// deliberate presses. The row is rebuilt by the first press and the page
// carries focus across -- which control it lands on is a keyboard fact the DOM
// harness can only approximate, so here it is pressed for real: Enter twice,
// then a held Enter (auto-repeat), with no profile retired by any of it.
test('Enter twice, or held, on a profile\'s Retire never retires it: the carried focus lands on Keep', async () => {
  await withDaemon(root, async (d) => {
    const browser = await launchBrowser(chrome.executable, mkdtempSync(join(root.root, 'chrome-')));
    const until = async (expr: string, what: string) => {
      for (let i = 0; i < 100; i++) {
        if (await browser.cdp.eval<boolean>(expr)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`the browser never reached: ${what}`);
    };
    const enter = (autoRepeat = false) => browser.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', autoRepeat,
    }).then(() => autoRepeat ? undefined : browser.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
    }));
    const focused = () => browser.cdp.eval<string>(`(document.activeElement.getAttribute('aria-label') || document.activeElement.textContent)`);
    const scribeListed = async () => {
      const res = await fetch(`${d.baseUrl}/profiles`, { headers: { Authorization: `Bearer ${d.token}` } });
      return ((await res.json()) as { name: string }[]).some((p) => p.name === 'Scribe');
    };
    try {
      await browser.openPage(d.baseUrl, d.token);
      await until(`!!document.querySelector('#fleetList button[aria-label="Retire Scribe"]')`, 'the Scribe row');
      await browser.cdp.eval(`(document.querySelector('#fleetList button[aria-label="Retire Scribe"]').focus(), true)`);

      await enter();
      assert.equal(await focused(), 'Keep', 'the first Enter left focus on the confirm');
      await enter();
      assert.equal(await focused(), 'Retire Scribe', 'Keep did not hand focus back to Retire');

      await enter();                                    // confirm row again, focus on Keep
      for (let i = 0; i < 6; i++) await enter(true);   // a held Enter
      await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(await scribeListed(), true, 'Enter presses alone retired the profile');

      // The deliberate path still works: move to the confirm, then press it.
      // A held Enter toggles between the two states, so settle on the plain row first.
      await browser.cdp.eval(`(() => { const c = document.querySelector('#fleetList button[aria-label="Confirm: retire Scribe"]');
        if (c) c.parentNode.querySelector('button').click(); return true; })()`);
      await until(`!!document.querySelector('#fleetList button[aria-label="Retire Scribe"]')`, 'the plain Scribe row');
      await browser.cdp.eval(`(document.querySelector('#fleetList button[aria-label="Retire Scribe"]').click(), true)`);
      await until(`!!document.querySelector('#fleetList button[aria-label="Confirm: retire Scribe"]')`, 'the confirm');
      await browser.cdp.eval(`(document.querySelector('#fleetList button[aria-label="Confirm: retire Scribe"]').focus(), true)`);
      await enter();
      await until(`!document.querySelector('#fleetList button[aria-label="Retire Scribe"]') && !document.querySelector('#fleetList button[aria-label="Confirm: retire Scribe"]')`, 'the Scribe row to go');
      assert.equal(await scribeListed(), false, 'the deliberate confirm did not retire');
    } finally {
      await browser.close();
    }
  });
});

}

/** withDaemon, but on a state directory the caller has already seeded. */
async function withDaemonAt(
  stateDir: string, serveArgs: string[], body: (d: { baseUrl: string; token: string }) => Promise<void>,
): Promise<void> {
  const { spawnServe } = await import('./testDaemon.ts');
  const { readFileSync } = await import('node:fs');
  const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '0.1', '--json', ...serveArgs]);
  try {
    const { port } = await handle.waitForListening();
    const token = (JSON.parse(readFileSync(join(stateDir, 'daemon.json'), 'utf8')) as { token: string }).token;
    await body({ baseUrl: `http://127.0.0.1:${port}`, token });
  } finally {
    await handle.kill();
  }
}
