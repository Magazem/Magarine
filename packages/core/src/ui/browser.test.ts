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
import { mkdtempSync } from 'node:fs';
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
