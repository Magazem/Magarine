// Batch 15 (docs/strategy/batch-15-spec.md section 3, Role B, deliverable 1),
// which is batch 14 step 2: THE OLD INLINE PAGE IS GONE.
//
// What this file used to be: 443 lines of HTML and JavaScript in a template
// literal, served by daemonApi.ts's `GET /`. What it is now: a loader that
// reads packages/core/ui/index.html off disk. The page itself, its two
// stylesheets, its script, the organism generator and the two fonts are FILES,
// served at `GET /ui/<name>` (ruling 12) and editable without touching
// TypeScript.
//
// RULE 9 -- A SILENT FALLBACK IS NOT ALLOWED, and that is the whole design of
// this file. There is no inline copy of the page left to fall back to, not
// even a minimal one: if `ui/index.html` is missing or unreadable this THROWS,
// naming the path it looked for and the command that diagnoses it. A daemon
// quietly serving a different, older page than the one the owner approved is
// precisely the failure that rule was written about. Failing loudly, at
// startup, is the correct behaviour -- the page cannot half-exist.
//
// WHY THIS IS STILL CALLED PAGE_HTML AND STILL LIVES HERE: daemonApi.ts
// imports it for its `GET /` handler, and daemonApi.ts belongs to another
// engineer working in parallel. Keeping the export means ruling 12's static
// route can take `GET /` over whenever they are ready, with no flag day and no
// coordination. Nothing here assumes this file survives that.
//
// The read happens ONCE, at import. A restart picks up an edited page; a
// running daemon does not change the page under a connected browser, which is
// the safer of the two behaviours.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved relative to THIS MODULE, never to the working directory: the daemon
// is started from wherever the owner happens to be standing.
// packages/core/src/ui/page.ts -> packages/core/ui
export const UI_DIR: string = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');

/** The five files the page is built from, plus the two fonts it loads and its favicon. The
 *  daemon serves each at `GET /ui/<name>` and `doctor` checks every one. The
 *  page requests nothing outside this list -- see ui/ELEMENT-FIELD-TABLE.md. */
export const UI_ASSETS: readonly string[] = [
  'index.html',
  'tokens.css',
  'skin-brutalist.css',
  'organism.js',
  'fontCoverage.js',
  'app.js',
  'JetBrainsMono.woff2',
  'IBMPlexSans.woff2',
  'favicon.svg',
];

export const INDEX_HTML_PATH: string = join(UI_DIR, 'index.html');

/**
 * Read the page from a given path. Separate from the constant below so the
 * failure path is reachable from a test without deleting the real asset --
 * `page.test.ts` calls it with a path that does not exist and asserts the
 * message names it. A throw nobody has ever seen thrown is not a guarantee.
 */
export function readPageHtml(path: string = INDEX_HTML_PATH): string {
  let html: string;
  try {
    html = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(
      `the interface is missing: ${path} could not be read. The daemon serves ` +
        'packages/core/ui/index.html and keeps NO built-in copy of the page to fall back to ' +
        '(batch 14 rule 9). Run `magarine doctor` to check every asset route.',
      { cause }
    );
  }
  if (html.trim().length === 0) {
    // An empty file is the same failure wearing a different hat: the daemon
    // would answer 200 with a blank page and say nothing was wrong.
    throw new Error(`the interface is empty: ${path} exists but contains nothing.`);
  }
  return html;
}

/** The page, as daemonApi.ts's `GET /` handler already expects it. */
export const PAGE_HTML: string = readPageHtml();
