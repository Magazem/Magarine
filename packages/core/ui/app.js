// ===========================================================================
// Magarine — the page's behaviour. Batch 15, Role B (batch-15-spec.md s3).
//
// THE VANILLA RULE. No build step, no framework, no bundler, no network beyond
// this daemon. This file is shipped and parsed exactly as written.
//
// FOUR RULES THIS FILE IS WRITTEN AGAINST, each of which shows up as code:
//
//   RULE 8 — the interface shows only what the daemon measures. Every value
//   rendered below comes out of a named response field. Where pass 3 drew
//   something no field backs, it is ABSENT here and listed in
//   ui/ELEMENT-FIELD-TABLE.md. There is no mock data in this file: search it
//   for a ticket id, a title or an agent name and you will not find one.
//
//   RULE 9 — a silent fallback is not allowed. When the event stream is not
//   available the page SAYS SO, in words, and says it is polling. When the
//   interface font fails to load it says so. When the daemon sends text the
//   bundled font cannot draw it says so. None of these is a colour change or
//   a missing element; each is a sentence.
//
//   RULING 13 REQUIREMENT 3 — THE SCRIPT SETS STATE, NEVER STYLE. This file
//   writes text, data-* attributes and semantic class names. It never reaches
//   for an element's style property, never sets a style attribute, and sets no
//   class name from the presentational list src/ui/skin.test.ts owns. That
//   test is a WHOLE-FILE grep with no comment stripping, deliberately: a test
//   that can be satisfied by moving a violation into a comment is fooled in
//   both directions, so this paragraph is worded to avoid the literal tokens
//   rather than the test being weakened to tolerate them.
//   Colour comes from `data-status`, scale from
//   `data-size`, the activity order from `data-step`, the board's view from
//   `data-board-view` — every one of them resolved in CSS. That is what lets
//   the owner's own design arrive later as a stylesheet instead of a rewrite.
//
//   THE ORGANISM ANIMATES ONCE, ON A REAL EVENT, AND NEVER LOOPS. A loader
//   spinning while nothing runs is precisely the lie this batch exists to
//   prevent. The one animation helper is called from exactly one place: the
//   comparison that finds a ticket's progress sequence has ADVANCED on the
//   board (ruling 18). src/ui/skin.test.ts counts the call sites
//   with a whole-file grep and no comment stripping, so this paragraph avoids
//   naming the helper rather than that test being weakened to tolerate it.
//
// XSS: every daemon value reaches the DOM through textContent or a data
// attribute. There is no innerHTML call taking daemon data anywhere here.
// ===========================================================================
(function () {
  'use strict';

  var ORG = globalThis.MagarineOrganism;
  var COVERAGE = globalThis.MagarineFontCoverage;

  // -----------------------------------------------------------------------
  // The board's six lanes over the daemon's eight statuses. NOTHING IS
  // HIDDEN: CANCELLED shares the terminal lane with DONE, struck through,
  // rather than being dropped. A lane set that hides a status is forbidden.
  // The statuses are types.ts's TicketStatus, exactly.
  // -----------------------------------------------------------------------
  var STATUS_LANES = [
    { key: 'waiting', name: 'Waiting',     statuses: ['OPEN', 'READY'] },
    { key: 'active',  name: 'In progress', statuses: ['IN_PROGRESS'] },
    { key: 'review',  name: 'Review',      statuses: ['REVIEW'] },
    { key: 'blocked', name: 'Blocked',     statuses: ['BLOCKED'] },
    { key: 'failed',  name: 'Failed',      statuses: ['FAILED'] },
    { key: 'done',    name: 'Done',        statuses: ['DONE', 'CANCELLED'] }
  ];

  // commands/board.ts's own STATUS_ORDER, so the list view reads in the same
  // order the CLI board does.
  var STATUS_ORDER = ['BLOCKED', 'FAILED', 'IN_PROGRESS', 'REVIEW', 'READY', 'OPEN', 'DONE', 'CANCELLED'];

  // -----------------------------------------------------------------------
  // ACTIVITY = MOTION. Which cells fire and in what ORDER when a real event
  // lands. One entry per state in the daemon's latestActivity.state.
  //
  // ALL SIX STATES ARE REAL AND SOURCED (ruling 14): reading, writing,
  // running, testing, finishing, reporting. `testing` was sourceable but
  // discarded by the adapter; it was fixed at the source rather than drawn as
  // a promise. THE TWO STATES IN THE OWNER'S LIST THAT NOTHING EMITS ARE NOT
  // HERE — they are named in ui/ELEMENT-FIELD-TABLE.md's omissions list, and
  // src/ui/motion.test.ts greps this whole file for them without stripping
  // comments, so they are not named here either.
  //
  // Each returns an INTEGER 0..24: the cell's place in the firing order. The
  // delay itself is tokens.css's table, keyed on data-step. The script decides
  // order; the stylesheet decides timing. No state is "faster" or "more
  // urgent" than another, because nothing measures that.
  //
  // An unmapped state plays `running` rather than being dropped or guessed at,
  // and src/ui/motion.test.ts pins that.
  // -----------------------------------------------------------------------
  function row(i) { return Math.floor(i / 5); }
  function col(i) { return i % 5; }
  function ring(i) { return Math.max(Math.abs(row(i) - 2), Math.abs(col(i) - 2)); }

  var MOTION = {
    reading:   function (i) { return col(i); },                   // scan, column by column
    writing:   function (i) { return row(i); },                   // line by line
    running:   function (i) { return ring(i); },                  // fill, centre outward
    testing:   function (i) { return ((row(i) + col(i)) % 2) * 3; }, // alternate
    finishing: function (i) { return 2 - ring(i); },              // assemble, outside in
    reporting: function (i) { return (i * 7) % 25; }              // scatter, deterministic
  };
  function motionFor(state) {
    return Object.prototype.hasOwnProperty.call(MOTION, state) ? MOTION[state] : MOTION.running;
  }

  // "What happens next", keyed on InboxItem.eventType. THIS IS COPY, NOT A
  // MEASUREMENT: it describes what the daemon will do with this item, which is
  // fixed per event type. It is listed as copy in the element-field table
  // rather than claimed as a field. An event type with no entry gets no line
  // at all rather than an invented one.
  var WHAT_NEXT = {
    worker_needs_user_decision:
      'Answer and the ticket returns to READY; this worker resumes and anything blocked behind it unblocks.',
    worker_needs_review:
      'Approve and it lands DONE. Reject with a reason and it retries with that reason attached.',
    worker_failed_final:
      'Retry once the reason above is addressed: attempts reset and the ticket returns to READY.',
    project_spend_cap_reached:
      'Raise the cap and the project resumes from where it stopped.',
    adapter_unavailable:
      'Resume the project once the adapter is reachable again.'
  };

  // WHY A PROJECT IS PAUSED, as a heading. Keyed on BoardResult.pauseReason,
  // which is structured precisely so this page never parses the message text.
  // A reason with no entry here gets the plain "Paused" and the daemon's own
  // message, which is rule 9's shape: a cause this page does not recognise is
  // not a cause it hides.
  //
  // RULING 24 (batch 16) adds the readiness causes. THE THREE RULE NAMES ARE
  // THE DAEMON'S, and Role A's item 5 is what will emit them; `project_not_ready`
  // is carried too, for a daemon that names the family rather than the rule.
  var PAUSE_HEADS = {
    spend_cap: 'Paused — spend cap reached',
    adapter_unavailable: 'Paused — adapter unavailable',
    missing_workspace_root: 'Paused — this project has no folder',
    unsafe_workspace_root: 'Paused — this project’s folder is not safe to work in',
    missing_scope_path: 'Paused — this project has no scope file',
    // RULING 29: the scope document EXISTS but cannot be read (permissions, or
    // a directory at that path). Not "no scope file": a different fault with a
    // different fix, so it does not borrow that heading.
    unreadable_scope_file: 'Paused — this project’s scope file cannot be read',
    project_not_ready: 'Paused — this project is not ready to run'
  };

  // The causes whose fix is one command rather than a button on this page.
  var READINESS_REASONS = [
    'missing_workspace_root', 'unsafe_workspace_root', 'missing_scope_path', 'unreadable_scope_file',
    'project_not_ready'
  ];

  // The command that fixes each readiness cause. The directory causes are
  // fixed by choosing a folder; an unreadable scope file is fixed by repairing
  // the file and then resuming, so it names a different command.
  function readinessFix(reason) {
    var id = state.projectId || '';
    return reason === 'unreadable_scope_file'
      ? 'magarine resume --project ' + id
      : 'magarine project set --project ' + id + ' --dir <folder>';
  }

  // The actions an item offers, keyed on the same field. An event type with no
  // entry offers none — rule 7's converse: if the daemon cannot name a next
  // command for it, the page does not draw a button pretending it can.
  var ACTIONS = {
    worker_needs_user_decision: [
      { kind: 'answer', label: 'Answer', route: 'decide', field: 'answer', placeholder: 'your answer', go: true }
    ],
    worker_needs_review: [
      { kind: 'button', label: 'Approve', route: 'approve', go: true },
      { kind: 'answer', label: 'Reject', route: 'reject', field: 'reason', placeholder: 'reject reason' }
    ],
    worker_failed_final: [
      { kind: 'button', label: 'Retry', route: 'retry' }
    ]
  };

  var EVENT_TONE = {
    worker_failed_final: 'bad', worker_failed_retryable: 'bad',
    project_spend_cap_reached: 'bad', adapter_unavailable: 'bad',
    worker_needs_user_decision: 'attention', worker_needs_review: 'attention',
    worker_done: 'good'
  };

  var POLL_MS = 4000;
  var FONT_NOTICE = 'interface font did not load, run magarine doctor';

  var state = {
    token: null,
    projectId: null,
    projects: [],
    board: null,
    inbox: [],
    activity: [],
    conversation: [],
    scopeText: '',
    scopeStatus: null,
    scopeError: null,
    convFilter: 'all',
    live: false,            // true only while a stream is genuinely open
    lastSequence: 0,
    // The project list as a key, so the selector is rebuilt only when it changed.
    projectsKey: null,
    // RULING 18. THE PER-TICKET ANIMATION MARKER: the highest
    // latestActivity.sequence this page has already animated for each ticket,
    // with the state it animated and when. The organism ticks when — and only
    // when — that integer ADVANCES, which is what makes "once per progress
    // event" a structural fact rather than a timer's promise.
    motion: {}
  };

  // How long one pass of the organism runs, matching tokens.css's --tick
  // budget. Used to decide whether an animation interrupted by a re-render is
  // still owed the rest of its run.
  var MOTION_MS = 1600;

  // -----------------------------------------------------------------------
  // tiny DOM helpers. `el` takes a class name and text; nothing here sets a
  // style, and src/ui/skin.test.ts proves the file contains no way to.
  // -----------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  // Every class name in this file is lowercase kebab-case, space-separated.
  // THIS IS CHECKED, NOT ASSUMED, AND IT IS NOT DECORATION: `el(tag, text)` --
  // forgetting the null in the middle -- silently puts a DAEMON VALUE in the
  // class attribute. It happened here: an artefact's path shipped as
  // class="C:/work/sqlite-notes/delete.md" and the path simply vanished from
  // the page, with no error anywhere. That is a silent failure (rule 9) and a
  // daemon value becoming a class name (ruling 13 requirement 3) in one
  // mistake, so the choice is removed rather than documented (rule 6).
  var CLASS_SHAPE = /^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) {
      if (!CLASS_SHAPE.test(cls)) throw new Error('not a class name: ' + cls);
      n.className = cls;
    }
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // -----------------------------------------------------------------------
  // the daemon
  //
  // Auth: the token is typed in once and kept in sessionStorage (cleared when
  // the tab closes) — never a cookie, never in the URL, never sent anywhere
  // but as the Authorization header on this page's own calls to the daemon it
  // was loaded from. The browser's EventSource cannot set a header, which is
  // why the stream below is a streaming fetch() and not an EventSource.
  // -----------------------------------------------------------------------
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Authorization': 'Bearer ' + state.token };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        showGate('that token was refused by the daemon');
        throw new Error('unauthorized');
      }
      if (!res.ok) {
        return res.text().then(function (t) { throw new Error(res.status + ' ' + path + ': ' + t); });
      }
      return res.status === 204 ? null : res.json();
    });
  }

  // -----------------------------------------------------------------------
  // NOTICES — rule 9. Each says, in a sentence, a specific thing that is not
  // working. None is dismissible: the condition clears it, a click does not.
  // -----------------------------------------------------------------------
  function setNotice(id, text, why, cmd) {
    var box = $('notices');
    var existing = document.getElementById(id);
    if (!text) { if (existing) box.removeChild(existing); return; }
    var n = existing || el('div', 'notice');
    n.id = id;
    clear(n);
    n.appendChild(document.createTextNode(text));
    if (cmd) n.appendChild(el('span', 'cmd', cmd));
    if (why) n.appendChild(el('span', 'why', why));
    if (!existing) box.appendChild(n);
  }

  // -----------------------------------------------------------------------
  // THE ORGANISM. Shape from the generator, colour from the ticket status,
  // motion only on a real event.
  //
  // THE TIER IS DERIVED ONCE, IN organism.js. This file calls ORG.tierOf and
  // never re-implements it (batch 15 spec, deliverable 3).
  // -----------------------------------------------------------------------
  function seedFor(modelId) {
    // BoardTicket.model is null when the ticket falls back to the project's
    // default. Handing null to the generator would render every such ticket
    // as the "unknown" tier — wrong, and plausible-looking, which is worse.
    var project = currentProject();
    return modelId || (project && project.defaultModel) || '';
  }

  // EVERY data-* THIS FILE WRITES IS EITHER RESOLVED BY A STYLESHEET OR USED BY
  // A SELECTOR HERE, and src/ui/skin.test.ts enforces exactly that. An
  // attribute nothing consumes is the same trap as an unused token that fails
  // contrast: it reads as a hook a skin can rely on, and it is not one.
  //
  // Five were removed under that rule rather than left as decoration:
  // data-ticket and data-event (nothing reads them; data-org-for is the
  // addressing hook that is actually used), data-doing-for (read only by the
  // stream branch ruling 18 deleted -- the live line now comes from the board
  // render, so the hook outlived its one reader),
  // data-reason on the pause banner (the cause is in the heading text), and
  // data-tier on the organism. THAT LAST ONE MATTERS: offering the tier as a
  // styling hook invites a skin to colour by tier, and colour is status. The
  // three channels must not collide, so the hook does not exist. The tier is
  // still in the organism's title and aria-label, where it is a name and not a
  // selector.
  function makeOrg(modelId, status, size) {
    var seed = seedFor(modelId);
    var node = el('span', 'org');
    var tier = seed ? ORG.tierOf(seed) : 'unknown';
    if (size) node.setAttribute('data-size', size);
    if (status) node.setAttribute('data-status', status);
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', 'agent organism, model tier ' + tier);
    node.title = (seed || 'no model recorded') + ' \u00B7 tier ' + tier;
    var cells = ORG.organism(seed);
    for (var i = 0; i < cells.length; i++) {
      var cell = el('i');
      if (cells[i]) cell.setAttribute('data-on', '1');
      node.appendChild(cell);
    }
    return node;
  }

  // ONE PASS. Called from exactly one place: syncMotion, when a ticket's
  // latestActivity.sequence has ADVANCED past the last one animated (ruling
  // 18). A timer can cause a board read; it can never cause a pass unless that
  // read carries a new event. The delay per cell is tokens.css's business;
  // this writes only the cell's place in the order.
  // Put the firing order on the cells and arm the one animation. Split out of
  // the one-pass helper below because a re-render that replaces the organism mid-run has to put
  // the SAME pass back on the new node without that counting as a new event.
  function applyMotion(node, activityState) {
    var order = motionFor(activityState);
    var cells = node.children;
    node.removeAttribute('data-tick');
    void node.offsetWidth;                       // restart the one animation
    for (var i = 0; i < cells.length; i++) cells[i].setAttribute('data-step', String(order(i)));
    node.setAttribute('data-tick', activityState);
  }

  function tick(node, activityState) {
    if (!node) return;
    applyMotion(node, activityState);
    window.setTimeout(function () { node.removeAttribute('data-tick'); }, MOTION_MS);
  }

  // RULING 18 REQUIREMENT 4, AND IT IS THE SUBTLE ONE. Under this ruling a
  // progress frame's only effect is to RE-READ THE BOARD, and renderBoard
  // builds a fresh card — and so a fresh organism — for every ticket on every
  // render. So the very refresh a frame causes would replace the node that
  // frame set animating, and the animation this whole path exists to produce
  // would be destroyed by the path itself.
  //
  // A replaced node cannot simply be re-armed: re-applying the attributes
  // restarts the pass from zero, so a run of renders inside the window would
  // leave an organism twitching at its first frame forever and never
  // completing. Instead the new node is armed and then FAST-FORWARDED to where
  // the old one had got to, which is what makes the interruption invisible
  // rather than merely survivable.
  // RULING 18. THE ORGANISM ANIMATES FROM THE BOARD'S OWN MARKER, and this is
  // the only place it animates at all.
  //
  // latestActivity.sequence IS the events.sequence of the newest
  // worker_progress row on the running run — the same integer the stream frame
  // carries as its `id`. So the page is not approximating the event from the
  // board; it is reading the same event through the field the board already
  // publishes. Nothing is invented (rule 8), the frame is what causes the read
  // ("from the stream"), and the tick fires only when the integer advances, so
  // "once per event" is structural.
  //
  // The reason this replaced reading the frame's own entity: a worker_progress
  // event is recorded against the RUN (entityType 'run'), every organism on
  // this page is keyed by TICKET id, and the event row carries no ticketId at
  // all — so the old path could never resolve a node and never animated
  // anything. src/ui/stream.test.ts proves that against a real daemon.
  //
  // THE SAME COMPARISON IS REACHED BY THE FOUR-SECOND POLL, deliberately. That
  // is what turns "falls back to polling when the stream is down" from a
  // sentence into an exercised branch: with no stream the marker still
  // advances, just later.
  function syncMotion() {
    var tickets = (state.board && state.board.tickets) || [];
    var now = Date.now();
    var present = {};
    for (var i = 0; i < tickets.length; i++) {
      var t = tickets[i];
      present[t.id] = true;
      var a = activityOf(t);
      // No mapped activity is not an event. The ticket is not ticked and its
      // marker is left exactly as it was, so a ticket that stops reporting
      // does not re-animate when it starts again at an older sequence.
      if (!a) continue;
      var mark = state.motion[t.id];
      if (!mark || a.sequence > mark.sequence) {
        state.motion[t.id] = { sequence: a.sequence, state: a.state, at: now };
        tick(orgFor(t.id), a.state);
      } else if (now - mark.at < MOTION_MS) {
        // Same event, but a render has just replaced the node underneath a run
        // that had not finished. Put it back where it was.
        resumeMotion(orgFor(t.id), mark, now);
      }
    }
    // A ticket that has left the board keeps no marker; it is gone, not idle.
    for (var id in state.motion) if (!present[id]) delete state.motion[id];
  }

  function resumeMotion(node, mark, now) {
    if (!node || !node.getAnimations) return;
    applyMotion(node, mark.state);
    var elapsed = now - mark.at;
    var running = node.getAnimations({ subtree: true });
    for (var i = 0; i < running.length; i++) running[i].currentTime = elapsed;
  }

  // -----------------------------------------------------------------------
  // small formatters
  // -----------------------------------------------------------------------
  function currentProject() {
    for (var i = 0; i < state.projects.length; i++) {
      if (state.projects[i].id === state.projectId) return state.projects[i];
    }
    return null;
  }

  function money(usd) { return '$' + Number(usd || 0).toFixed(2); }

  // Cards carry the short id; the full id is in the list view, in Needs you
  // and in the conversation. A card spending three lines on an id is not
  // dense, it is just full.
  function shortId(id) {
    if (!id) return '';
    var cut = String(id).indexOf('-');
    return cut > 0 ? String(id).slice(0, cut) : String(id);
  }

  function ago(iso) {
    var then = Date.parse(iso);
    if (!then) return '';
    var s = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }

  function hhmmss(iso) {
    var t = Date.parse(iso);
    return t ? new Date(t).toISOString().slice(11, 19) : '';
  }

  function ticketById(id) {
    var ts = (state.board && state.board.tickets) || [];
    for (var i = 0; i < ts.length; i++) if (ts[i].id === id) return ts[i];
    return null;
  }

  /** latestActivity, from the board rows -- the daemon's own spelling. null
   *  and null for any ticket that is not running — both render as no line,
   *  never as an invented one. */
  function activityOf(ticket) { return (ticket && ticket.latestActivity) || null; }

  function doingText(ticket) {
    var a = activityOf(ticket);
    if (!a) return null;
    return a.tool ? a.state + ' \u00B7 ' + a.tool : a.state;
  }

  function costText(t) {
    return t.costIsEstimate ? 'at least ' + money(t.costUsd) + ' \u2014 live estimate' : money(t.costUsd);
  }

  // The machine's concurrency ceiling, which is why "only one thing is moving".
  // `used` counts IN_PROGRESS tickets across EVERY project, so it can exceed
  // this project's own worker count; `cap` is the daemon's --max-parallel and
  // is null when nothing measured it -- then no denominator is shown.
  function slotsText(slots) {
    if (!slots || typeof slots.used !== 'number') return '';
    if (typeof slots.cap !== 'number') return slots.used + ' slots in use machine-wide';
    var text = slots.used + ' of ' + slots.cap + ' slots in use machine-wide';
    return slots.used >= slots.cap ? text + ' — full, other tickets wait' : text;
  }

  // ------------------------------------------------------------ fleet ----
  // A row per ticket that is actually running. The daemon has no agent
  // entity, no roster and no idle worker, so neither does this.
  function renderFleet() {
    var list = $('fleetList');
    clear(list);
    var running = ((state.board && state.board.tickets) || []).filter(function (t) {
      return t.status === 'IN_PROGRESS';
    });
    $('fleetCount').textContent = running.length + (running.length === 1 ? ' worker' : ' workers');
    $('fleetSlots').textContent = slotsText(state.board && state.board.slots);
    if (!running.length) {
      list.appendChild(el('div', 'empty', 'no ticket is IN_PROGRESS'));
      return;
    }
    running.forEach(function (t) {
      var r = el('div', 'fleet-row');
      r.setAttribute('data-status', t.status);
      r.appendChild(makeOrg(t.model, t.status));
      var who = el('span', 'who');
      var model = seedFor(t.model);
      who.appendChild(el('span', 'name', model ? ORG.tierOf(model) : 'no model recorded'));
      who.appendChild(el('span', 'tier', model || 'tickets.model is null and the project has no default'));
      var doing = doingText(t);
      var line = el('span', 'doing', doing || 'no progress event recorded yet');
      if (!doing) line.setAttribute('data-idle', '1');
      who.appendChild(line);
      r.appendChild(who);
      list.appendChild(r);
    });
  }

  // ------------------------------------------------------------ board ----
  function artsNode(artifacts) {
    if (!artifacts || !artifacts.length) return null;
    var wrap = el('span', 'arts');
    artifacts.forEach(function (a) {
      var art = el('span', 'art');
      art.setAttribute('data-kind', a.kind);
      art.appendChild(el('span', 'k', a.kind));
      // ARTEFACT BY KIND: a file shows its path; a text-bearing kind shows its
      // kind and a LENGTH, never its body. The body is the worker's output and
      // belongs in the ticket, not on a card.
      art.appendChild(el('span', null, a.kind === 'file'
        ? (a.content || '(no path recorded)')
        : (String(a.content || '').length + ' chars')));
      wrap.appendChild(art);
    });
    return wrap;
  }

  function ticketCard(t) {
    var card = el('div', 'ticket');
    card.setAttribute('data-status', t.status);
    card.appendChild(el('span', 'tid', shortId(t.id)));
    card.appendChild(el('div', 'title', t.title));

    var meta = el('div', 'meta');
    var org = makeOrg(t.model, t.status, 'sm');
    org.setAttribute('data-org-for', t.id);
    meta.appendChild(org);
    var doing = doingText(t);
    var line = el('span', 'doing', doing || costText(t));
    if (!doing) line.setAttribute('data-idle', '1');
    meta.appendChild(line);
    card.appendChild(meta);

    if (t.attemptCount > 0) card.appendChild(el('div', 'dep', t.attemptCount + '/' + t.maxAttempts + ' attempts'));
    if (t.blockedBy && t.blockedBy.length) {
      card.appendChild(el('div', 'dep', 'blocked by ' + t.blockedBy.map(shortId).join(', ')));
    }
    if (t.usedFallbackRate) {
      card.appendChild(el('div', 'dep', 'priced at the fallback rate \u2014 this model is not in pricing.ts'));
    }
    var arts = artsNode(t.artifacts);
    if (arts) card.appendChild(arts);
    return card;
  }

  function renderBoard() {
    var lanes = $('lanes');
    clear(lanes);
    var tickets = (state.board && state.board.tickets) || [];
    var running = tickets.filter(function (t) { return t.status === 'IN_PROGRESS'; }).length;
    $('boardCount').textContent = tickets.length + (tickets.length === 1 ? ' ticket' : ' tickets') +
      ' \u00B7 ' + running + ' running';

    STATUS_LANES.forEach(function (spec) {
      var mine = tickets.filter(function (t) { return spec.statuses.indexOf(t.status) >= 0; });
      var lane = el('div', 'lane');
      lane.setAttribute('data-lane', spec.key);
      var head = el('div', 'lane-head');
      head.appendChild(el('span', 'name', spec.name));
      head.appendChild(el('span', 'count', String(mine.length)));
      lane.appendChild(head);
      var body = el('div', 'lane-body');
      mine.forEach(function (t) { body.appendChild(ticketCard(t)); });
      lane.appendChild(body);
      lanes.appendChild(lane);
    });

    renderList(tickets);
  }

  function renderList(tickets) {
    var body = $('listBody');
    clear(body);
    tickets.slice().sort(function (a, b) {
      return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    }).forEach(function (t) {
      var tr = el('tr');
      tr.setAttribute('data-status', t.status);
      var first = el('td');
      first.appendChild(el('div', 'title', t.title));
      first.appendChild(el('span', 'tid mono', t.id));
      tr.appendChild(first);
      tr.appendChild(el('td', 'num', t.status));
      tr.appendChild(el('td', 'num', t.attemptCount + '/' + t.maxAttempts));
      var cost = el('td', 'num', costText(t));
      if (t.costIsEstimate) cost.setAttribute('data-estimate', '1');
      tr.appendChild(cost);
      tr.appendChild(el('td', 'num', doingText(t) || '\u2014'));
      body.appendChild(tr);
    });
  }

  // -------------------------------------------------------- needs you ----
  function actionRow(item) {
    var specs = ACTIONS[item.eventType];
    if (!specs || !item.ticketId) return null;
    var acts = el('div', 'acts');
    specs.forEach(function (spec) {
      if (spec.kind === 'button') {
        var b = el('button', spec.go ? 'btn btn-go' : 'btn', spec.label);
        b.type = 'button';
        b.addEventListener('click', function () { post(item.ticketId, spec.route, {}); });
        acts.appendChild(b);
        return;
      }
      var input = el('input', 'field');
      input.type = 'text';
      input.placeholder = spec.placeholder;
      input.setAttribute('aria-label', spec.placeholder);
      var go = el('button', spec.go ? 'btn btn-go' : 'btn', spec.label);
      go.type = 'button';
      go.addEventListener('click', function () {
        if (!input.value) { input.focus(); return; }
        var payload = {};
        payload[spec.field] = input.value;
        post(item.ticketId, spec.route, payload);
      });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); });
      acts.appendChild(input);
      acts.appendChild(go);
    });
    return acts;
  }

  function step(k, v, mono) {
    var s = el('div', 'step');
    s.appendChild(el('span', 'k', k));
    s.appendChild(el('span', mono ? 'v mono' : 'v', v));
    return s;
  }

  function askNode(item) {
    var t = item.ticketId ? ticketById(item.ticketId) : null;
    var status = t ? t.status : 'BLOCKED';
    var ask = el('div', 'ask');
    ask.setAttribute('data-status', status);

    var head = el('div', 'ask-head');
    head.appendChild(makeOrg(t && t.model, status, 'lg'));
    var who = el('span', 'who');
    var model = seedFor(t && t.model);
    who.appendChild(el('span', 'name', (model ? ORG.tierOf(model) : 'project') + ' \u00B7 ' + item.eventType));
    who.appendChild(el('span', 'tid', item.ticketId || item.projectId || ''));
    head.appendChild(who);
    head.appendChild(el('span', 'when', ago(item.createdAt) + ' ago'));
    ask.appendChild(head);

    var doing = t && doingText(t);
    if (doing) ask.appendChild(step('Doing', doing + ' \u2014 last event ' + hhmmss(activityOf(t).at), true));

    // THE REASON ELEMENT IS NEVER TRUNCATED OR CLAMPED, AND HAS NO SCROLL BOX OF
    // ITS OWN. A half-shown reason is useless, which is this panel's whole point.
    // In the board and scope views this panel is a rail that scrolls as a column
    // (the approved layout), so a long reason can sit below the rail's fold; the
    // Needs-you view shows it whole (batch-15-addendum-7 section 2(a)). InboxItem.message
    // already carries the exact command that clears the item.
    ask.appendChild(step('Stopped', item.message));

    if (t && t.artifacts && t.artifacts.length) {
      var d = el('div', 'step');
      d.appendChild(el('span', 'k', 'Delivered'));
      var v = el('span', 'v');
      v.appendChild(artsNode(t.artifacts));
      d.appendChild(v);
      ask.appendChild(d);
    }
    if (WHAT_NEXT[item.eventType]) ask.appendChild(step('Then', WHAT_NEXT[item.eventType]));

    var acts = actionRow(item);
    if (acts) ask.appendChild(acts);
    return ask;
  }

  function setTitle(waiting) {
    document.title = waiting > 0 ? '(' + waiting + ') Magarine' : 'Magarine';
  }

  function renderNeeds() {
    var items = state.inbox || [];
    $('needsSub').textContent = items.length + ' \u00B7 autonomous work has stopped and handed back';
    var badge = $('needsCount');
    badge.textContent = String(items.length);
    badge.hidden = items.length === 0;
    // The window's title carries the same count, so a taskbar entry says a
    // decision is waiting even while the window is behind another one.
    setTitle(items.length);

    var list = $('needsList');
    clear(list);
    if (!items.length) { list.appendChild(el('div', 'empty', 'nothing is waiting on you')); return; }
    items.forEach(function (item) { list.appendChild(askNode(item)); });
  }

  // --------------------------------------------------------- activity ----
  function renderActivity() {
    var feed = $('feed');
    clear(feed);
    var events = (state.activity || []).slice().sort(function (a, b) { return b.sequence - a.sequence; });
    $('activityCount').textContent = events.length ? hhmmss(events[0].createdAt) + ' \u00B7 UTC' : 'UTC';
    if (!events.length) { feed.appendChild(el('div', 'empty', 'no events recorded for this project')); return; }
    events.slice(0, 60).forEach(function (e) {
      var r = el('div', 'ev');
      r.appendChild(el('span', 't', hhmmss(e.createdAt)));
      var k = el('span', 'k', e.eventType);
      if (EVENT_TONE[e.eventType]) k.setAttribute('data-tone', EVENT_TONE[e.eventType]);
      r.appendChild(k);
      r.appendChild(el('span', 'e', shortId(e.entityId)));
      feed.appendChild(r);
    });
  }

  // ------------------------------------------- scope and conversation ----
  function renderScope() {
    // Rule 9: three different truths, three different sentences. An unreadable
    // file is never drawn as an empty document.
    var text = state.scopeText;
    if (state.scopeError) text = '(this project’s scope file exists but could not be read: ' + state.scopeError + ')';
    else if (!text && state.scopeStatus === 'absent') text = '(this project has no scope file yet)';
    else if (!text) text = '(the scope file is empty)';
    $('scopeText').textContent = text;
  }

  function renderConversation() {
    var entries = state.conversation || [];
    $('convCount').textContent = entries.length + (entries.length === 1 ? ' entry' : ' entries') +
      ' \u00B7 newest last';

    var tabs = $('convTabs');
    clear(tabs);
    var ids = [];
    entries.forEach(function (e) { if (e.ticketId && ids.indexOf(e.ticketId) < 0) ids.push(e.ticketId); });
    ['all'].concat(ids).forEach(function (id) {
      var b = el('button', null, id === 'all' ? 'All' : shortId(id));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.convFilter === id));
      b.addEventListener('click', function () { state.convFilter = id; renderConversation(); });
      tabs.appendChild(b);
    });

    var list = $('convList');
    clear(list);
    var shown = entries.filter(function (e) {
      return state.convFilter === 'all' || e.ticketId === state.convFilter;
    });
    if (!shown.length) { list.appendChild(el('div', 'empty', 'no entries for this filter')); return; }
    shown.forEach(function (e) {
      var art = el('article', 'entry');
      art.setAttribute('data-kind', e.kind);
      var t = e.ticketId ? ticketById(e.ticketId) : null;
      var who = el('div', 'who');
      if (e.kind !== 'owner_message' && e.kind !== 'scope_updated') {
        who.appendChild(makeOrg(t && t.model, t && t.status, 'sm'));
      }
      who.appendChild(el('span', 'name', e.kind === 'owner_message' ? 'You' : e.kind));
      who.appendChild(el('span', 'at', e.createdAt));
      art.appendChild(who);
      art.appendChild(el('div', 'text', e.text));

      // Only a still-unanswered question carries a live answer box, matching
      // the daemon's own rule that only a BLOCKED ticket has anything to
      // answer. `answered` is the entry's own field; absence is not "false".
      if (e.kind === 'question' && e.ticketId && e.answered !== true) {
        var acts = actionRow({ eventType: 'worker_needs_user_decision', ticketId: e.ticketId });
        if (acts) art.appendChild(acts);
      }
      list.appendChild(art);
    });
  }

  // ------------------------------------------------------------ pause ----
  function renderPause() {
    var banner = $('pauseBanner');
    var b = state.board;
    if (!b || !b.pauseMessage) { banner.hidden = true; return; }
    banner.hidden = false;
    $('pauseHead').textContent = PAUSE_HEADS[b.pauseReason] || 'Paused';
    $('pauseBody').textContent = b.pauseMessage;

    var acts = $('pauseActs');
    clear(acts);
    // pauseReason is structured precisely so the page can offer the fix that
    // matches the cause without parsing the message text.
    if (b.pauseReason === 'spend_cap') {
      var input = el('input', 'field');
      input.type = 'number';
      input.step = '0.01';
      input.placeholder = 'new max spend (usd)';
      input.setAttribute('aria-label', 'New maximum spend, in US dollars');
      input.setAttribute('data-field', 'max-spend');
      var go = el('button', 'btn btn-go', 'Raise cap');
      go.type = 'button';
      go.addEventListener('click', function () {
        if (!input.value) { input.focus(); return; }
        api('/projects/' + encodeURIComponent(state.projectId) + '/set',
            { method: 'POST', body: { maxSpendUsd: Number(input.value) } }).then(refresh, fail);
      });
      acts.appendChild(input);
      acts.appendChild(go);
    }

    // RULING 24 (batch 16). A project that is not ready to run is paused
    // through this same mechanism, and its fix is a command the owner runs in
    // a terminal — this page cannot choose a folder for them. So the banner
    // offers the exact command, with the project id already in it, and
    // NOTHING ELSE: no Resume, because resuming without a folder would fail
    // the same check and pause again, which is a button that cannot work.
    // Un-pausing IS `project set --dir`; the ruling says so.
    if (READINESS_REASONS.indexOf(b.pauseReason) >= 0) {
      acts.appendChild(el('span', 'mono', readinessFix(b.pauseReason)));
      return;
    }

    var resume = el('button', 'btn', 'Resume');
    resume.type = 'button';
    resume.addEventListener('click', function () {
      api('/projects/' + encodeURIComponent(state.projectId) + '/resume', { method: 'POST', body: {} })
        .then(refresh, fail);
    });
    acts.appendChild(resume);
  }

  // -----------------------------------------------------------------------
  // FONT READINESS — batch 14 ruling 1, checked through the browser's own
  // font-loading interface rather than by guessing at a timeout.
  //
  // document.fonts.check() answers "would this family be used for this text",
  // so it is asked AFTER document.fonts.ready resolves, for each family the
  // page actually sets. A browser with no FontFaceSet cannot be asked, and is
  // told so rather than given a silent pass.
  // -----------------------------------------------------------------------
  function checkFonts() {
    if (!document.fonts || !document.fonts.ready || !document.fonts.check) {
      setNotice('notice-font', FONT_NOTICE,
                'this browser does not expose a font-loading interface, so readiness cannot be confirmed');
      return;
    }
    var probe = 'Magarine';
    Promise.all([
      document.fonts.load('400 1rem "Magarine Sans"', probe),
      document.fonts.load('400 1rem "JetBrains Mono"', probe)
    ]).catch(function () { /* the check below is the verdict, not this */ })
      .then(function () { return document.fonts.ready; })
      .then(function () {
        var missing = [];
        if (!document.fonts.check('400 1rem "Magarine Sans"', probe)) missing.push('Magarine Sans (IBM Plex Sans)');
        if (!document.fonts.check('400 1rem "JetBrains Mono"', probe)) missing.push('JetBrains Mono');
        if (missing.length) setNotice('notice-font', FONT_NOTICE, 'not loaded: ' + missing.join(', '), 'magarine doctor');
        else setNotice('notice-font', null);
      });
  }

  // -----------------------------------------------------------------------
  // FONT COVERAGE — the other half of tokens.css's unicode-range blocks.
  // ONE call site, taking every string the page renders from the daemon. Miss
  // one here and the notice is wrong, so they are collected in one place
  // rather than at each render.
  // -----------------------------------------------------------------------
  function renderedStrings() {
    var out = [];
    (state.projects || []).forEach(function (p) { out.push(p.name, p.id, p.defaultModel); });
    ((state.board && state.board.tickets) || []).forEach(function (t) {
      out.push(t.title, t.id, t.status, t.model, t.modelReason);
      (t.blockedBy || []).forEach(function (b) { out.push(b); });
      (t.artifacts || []).forEach(function (a) { out.push(a.kind, a.content); });
      var act = activityOf(t);
      if (act) out.push(act.state, act.tool);
    });
    if (state.board && state.board.pauseMessage) out.push(state.board.pauseMessage);
    (state.inbox || []).forEach(function (i) { out.push(i.message, i.eventType, i.ticketId, i.projectId); });
    (state.activity || []).forEach(function (e) { out.push(e.eventType, e.entityId); });
    (state.conversation || []).forEach(function (c) { out.push(c.text, c.kind, c.ticketId); });
    out.push(state.scopeText);
    return out.filter(function (s) { return typeof s === 'string' && s.length > 0; });
  }

  function checkCoverage() {
    var verdict = COVERAGE.textOutsideFontCoverage(renderedStrings());
    // One line, once, beside the font-load notice. No per-string decoration,
    // no colour, no interruption — the owner's ruling.
    if (verdict.outside) {
      setNotice('notice-coverage', COVERAGE.COVERAGE_NOTICE, 'outside the bundled subsets: ' + verdict.sample);
    } else {
      setNotice('notice-coverage', null);
    }
  }

  // -----------------------------------------------------------------------
  // THE EVENT STREAM, and saying so when there isn't one.
  //
  // EventSource cannot set an Authorization header and the token must never go
  // in a URL, so this is a streaming fetch() that parses the server-sent event
  // framing itself.
  //
  // setLive IS NEVER OPTIMISTIC. It reads "polling" until a stream is actually
  // open, and returns to "polling" the instant one ends — including when the
  // daemon dies, which its fifteen-second comment line makes detectable. A
  // page saying "live" while nothing is connected is the same lie as a spinner
  // over nothing.
  // -----------------------------------------------------------------------
  function setLive(isLive, why) {
    state.live = isLive;
    var node = $('liveState');
    node.setAttribute('data-live', isLive ? 'stream' : 'poll');
    node.textContent = isLive ? 'live' : 'polling';
    if (isLive) {
      setNotice('notice-stream', null);
    } else {
      setNotice('notice-stream',
        'the event stream is not connected, so this page is polling every ' +
        (POLL_MS / 1000) + ' seconds and is not live', why || null);
    }
  }

  function orgFor(ticketId) {
    if (!ticketId) return null;
    return document.querySelector('[data-org-for="' + String(ticketId).replace(/["\\]/g, '\\$&') + '"]');
  }

  function handleStreamEvent(name, id, data) {
    if (id) state.lastSequence = Math.max(state.lastSequence, Number(id) || 0);

    if (name === 'worker_progress') {
      // RULING 18: A PROGRESS FRAME RE-READS THE BOARD AND DOES NOTHING ELSE.
      // It resolves no entity, animates nothing and writes no text of its own.
      // Everything visible follows from the board that comes back, through
      // syncMotion's one comparison — which is also what the poll reaches, so
      // there is ONE path here and not a live one beside a fallback one.
      refreshBoardOnly();
      return;
    }
    refresh();   // anything else changes state the page is showing
  }

  function openStream() {
    if (!window.fetch || !window.ReadableStream) {
      setLive(false, 'this browser cannot read a streaming response');
      return;
    }
    fetch('/events?since=' + encodeURIComponent(state.lastSequence),
          { headers: { 'Authorization': 'Bearer ' + state.token, 'Accept': 'text/event-stream' } })
      .then(function (res) {
        if (!res.ok || !res.body) throw new Error('stream refused: ' + res.status);
        setLive(true);
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) throw new Error('the daemon closed the stream');
            buffer += decoder.decode(r.value, { stream: true });
            var frames = buffer.split('\n\n');
            buffer = frames.pop();
            frames.forEach(function (frame) {
              var name = 'message', id = null, dataLines = [];
              frame.split('\n').forEach(function (line) {
                if (line.charAt(0) === ':') return;                  // the keep-alive comment
                if (line.indexOf('event:') === 0) name = line.slice(6).trim();
                else if (line.indexOf('id:') === 0) id = line.slice(3).trim();
                else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trim());
              });
              if (!dataLines.length) return;
              var parsed = null;
              try { parsed = JSON.parse(dataLines.join('\n')); } catch (e) { return; }
              handleStreamEvent(name, id, parsed);
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) {
        setLive(false, String((e && e.message) || e));
        // One retry per few poll intervals. Not a tight loop, and the page goes
        // on saying it is polling for as long as that is what it is doing.
        window.setTimeout(function () { if (state.token && !state.live) openStream(); }, POLL_MS * 4);
      });
  }

  // -----------------------------------------------------------------------
  // loading
  // -----------------------------------------------------------------------
  function fail(err) {
    if (err && err.message === 'unauthorized') return;
    setNotice('notice-daemon', 'the daemon did not answer', String((err && err.message) || err));
  }

  function renderSpend() {
    var b = state.board;
    var node = $('spend');
    if (!b) { node.textContent = ''; return; }
    var text = (b.projectSpendIsEstimate ? 'at least ' : '') + money(b.projectSpendUsd);
    if (b.projectMaxSpendUsd !== null && b.projectMaxSpendUsd !== undefined) {
      text += ' of ' + money(b.projectMaxSpendUsd);
    }
    if (b.projectUsedFallbackRate) text += ' \u00B7 fallback rate used';
    node.textContent = text;
    node.title = 'equivalent API cost \u2014 what the tool would have billed at metered rates. ' +
      'On a subscription this is not money leaving your account; the real constraint is session limits.';
  }

  // RULING 18 REQUIREMENT 3: COALESCED. A run emits hundreds of progress
  // events and under ruling 18 each frame's only effect is to call this, so
  // without a guard one run becomes hundreds of GET /board. One read in
  // flight; any frame arriving during it sets a single dirty flag; exactly one
  // more read follows when the first settles. A boolean, never a queue -- a
  // list of pending reads is the same defect with a delay bolted on.
  var boardRead = { inFlight: null, dirty: false };

  function refreshBoardOnly() {
    if (!state.projectId) return Promise.resolve();
    if (boardRead.inFlight) { boardRead.dirty = true; return boardRead.inFlight; }
    boardRead.inFlight = api('/board?project=' + encodeURIComponent(state.projectId)).then(function (b) {
      state.board = b;
      renderSpend(); renderFleet(); renderBoard(); renderPause();
      syncMotion();
    }, fail).then(function () {
      boardRead.inFlight = null;
      if (boardRead.dirty) { boardRead.dirty = false; return refreshBoardOnly(); }
    });
    return boardRead.inFlight;
  }

  function refresh() {
    if (!state.token) return Promise.resolve();
    // The list first, and on every pass: it decides which project the rest of
    // this read is even about.
    return api('/projects').then(function (list) {
      syncProjects(list);
      return state.projectId ? refreshProject() : undefined;
    }, fail);
  }

  // The daemon's 400 body is JSON with an error string; show that string, or
  // the raw body when it is not.
  function scopeErrorText(body) {
    try {
      var j = JSON.parse(body);
      if (j && typeof j.error === 'string') return j.error;
    } catch (e) { /* not JSON: show it as it came */ }
    return body;
  }

  function refreshProject() {
    var p = encodeURIComponent(state.projectId);
    return Promise.all([
      api('/board?project=' + p),
      api('/inbox?project=' + p),
      api('/activity?project=' + p),
      // A 400 here is the daemon saying the scope file cannot be READ (ruling
      // 29). It must not take the whole refresh down with it, nor be read as
      // an empty document: it is carried as its own state. Any other failure,
      // including a refused token, still fails the read as before.
      api('/projects/' + p + '/scope').catch(function (err) {
        var m = /^400 [^:]*: ([\s\S]*)$/.exec(String((err && err.message) || ''));
        if (!m) throw err;
        return { scopeError: scopeErrorText(m[1]) };
      }),
      api('/projects/' + p + '/conversation')
    ]).then(function (r) {
      state.board = r[0];
      state.inbox = r[1] || [];
      state.activity = r[2] || [];
      state.scopeText = (r[3] && r[3].scopeText) || '';
      state.scopeStatus = (r[3] && r[3].status) || null;
      state.scopeError = (r[3] && r[3].scopeError) || null;
      state.conversation = r[4] || [];
      state.activity.forEach(function (e) {
        state.lastSequence = Math.max(state.lastSequence, e.sequence || 0);
      });
      setNotice('notice-daemon', null);
      renderSpend(); renderFleet(); renderBoard(); renderNeeds();
      renderActivity(); renderScope(); renderConversation(); renderPause();
      syncMotion();            // the poll reaches the same one comparison
      checkCoverage();
    }, fail);
  }

  // BATCH 16 ITEM 1. The project list is re-read on the board's own cadence,
  // so a project created while this page is open appears without a reload —
  // the owner hit exactly that during their demo run.
  //
  // THE SELECTOR IS REBUILT ONLY WHEN THE LIST ACTUALLY CHANGED. Rebuilding it
  // every four seconds would fight the owner for their own control: it resets
  // the value, and it destroys and recreates the very <option> elements they
  // may have open. So the list is reduced to a key — every id and name, in
  // order — and an unchanged key touches nothing at all.
  function projectsKey(list) {
    return (list || []).map(function (p) { return p.id + '␟' + (p.name || ''); }).join('␞');
  }

  function syncProjects(list) {
    var next = list || [];
    state.projects = next;
    var key = projectsKey(next);
    if (key === state.projectsKey) return false;

    // The chosen project can disappear — deleted, or the daemon restarted on
    // another state directory. Falling back to the first one keeps the page
    // pointed at something the daemon actually has, rather than asking for a
    // project that is gone.
    var found = false;
    for (var i = 0; i < next.length; i++) if (next[i].id === state.projectId) found = true;
    if (!found) state.projectId = next.length ? next[0].id : null;

    state.projectsKey = key;
    var sel = $('projectSelect');
    clear(sel);
    next.forEach(function (p) {
      var o = el('option', null, p.name || p.id);
      o.value = p.id;
      sel.appendChild(o);
    });
    // An empty <select> renders as a small blank box that looks like a
    // broken control. There is nothing to choose between until the daemon
    // has answered, so there is nothing to show.
    sel.hidden = next.length === 0;
    sel.value = state.projectId || '';
    $('projectId').textContent = state.projectId || '';
    return true;
  }

  function post(ticketId, route, body) {
    api('/tickets/' + encodeURIComponent(ticketId) + '/' + route, { method: 'POST', body: body })
      .then(refresh, fail);
  }

  // -----------------------------------------------------------------------
  // the gate, the switches
  // -----------------------------------------------------------------------
  var REGIONS = ['fleet', 'board', 'needs-you', 'scope', 'conversation', 'activity'];

  function showGate(why) {
    state.token = null;
    try { window.sessionStorage.removeItem('magarine.token'); } catch (e) { /* private mode */ }
    $('gate').hidden = false;
    setTitle(0);
    $('projectSelect').hidden = true;
    setNotice('notice-auth', why || 'this page needs the daemon token before it can show anything', null);
    REGIONS.forEach(function (id) { $(id).hidden = true; });
  }

  function hideGate() {
    $('gate').hidden = true;
    setNotice('notice-auth', null);
    REGIONS.forEach(function (id) { $(id).hidden = false; });
  }

  function setBoardView(name) {
    // The view is state on the region; which of the two is displayed is the
    // skin's decision, resolved on [data-board-view] in CSS.
    $('board').setAttribute('data-board-view', name);
    var buttons = $('boardToggle').children;
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-board-view') === name));
    }
  }

  // RULING 15 (docs/strategy/batch-15-addendum-4-views-survive.md). THE THREE
  // VIEWS ARE ONE ATTRIBUTE ON THE ROOT. The nav never chose between three
  // pages — all three pass-3 screens carry the same grid, and it only ever
  // chose what the CENTRE COLUMN holds. So the script's whole job is to name
  // the state; ui/skin-brutalist.css decides what the name means.
  var VIEWS = ['board', 'needs-you', 'scope'];

  function hashView() {
    return String((window.location && window.location.hash) || '').replace(/^#/, '');
  }

  function setView(name) {
    // An unknown hash falls back to board rather than becoming a view no
    // stylesheet resolves, which would leave the centre column empty.
    var view = VIEWS.indexOf(name) === -1 ? 'board' : name;
    document.documentElement.setAttribute('data-view', view);
    // The matching nav entry, marked as the current one. Addressed by the
    // nav's own label rather than by a class name, so a skin renaming its
    // classes cannot silently break it.
    var links = document.querySelectorAll('nav[aria-label="Views"] a');
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('href') === '#' + view) links[i].setAttribute('aria-current', 'page');
      else links[i].removeAttribute('aria-current');
    }
    // NOTHING ELSE. This function takes nothing off the screen: with no
    // attribute at all the skin hides no region and the page is the anchor
    // page it started as. src/ui/skin.test.ts fails if that stops being true.
  }

  function setTheme(name) {
    document.documentElement.setAttribute('data-theme', name);
    try { window.localStorage.setItem('magarine.theme', name); } catch (e) { /* private mode */ }
    var buttons = $('themeToggle').children;
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-theme-set') === name));
    }
    // A theme swap changes which surfaces text lands on; the font faces are
    // unchanged by it, but re-asking costs nothing and keeps the notice honest
    // if a face was still loading at first paint.
    checkFonts();
  }

  // RULING 13 REQUIREMENT 4: the page loads the skin the root names. One skin
  // ships (brutalist); this is the mechanism, not a second skin.
  function applySkin() {
    var name = document.documentElement.getAttribute('data-skin') || 'brutalist';
    var link = $('skin');
    var href = '/ui/skin-' + name + '.css';
    if (link && link.getAttribute('href') !== href) link.setAttribute('href', href);
  }

  function wire() {
    $('saveToken').addEventListener('click', function () {
      var v = $('token').value.trim();
      if (!v) { $('token').focus(); return; }
      state.token = v;
      try { window.sessionStorage.setItem('magarine.token', v); } catch (e) { /* private mode */ }
      $('token').value = '';
      hideGate();
      refresh().then(function () { if (state.token) openStream(); });
    });
    $('token').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('saveToken').click(); });

    $('projectSelect').addEventListener('change', function (e) {
      state.projectId = e.target.value;
      $('projectId').textContent = state.projectId;
      refresh();
    });

    $('themeToggle').addEventListener('click', function (e) {
      var t = e.target.closest('[data-theme-set]');
      if (t) setTheme(t.getAttribute('data-theme-set'));
    });

    // The hrefs are real hashes, so the browser does the navigating, the
    // history and the focus move; this only follows along.
    window.addEventListener('hashchange', function () { setView(hashView()); });

    $('boardToggle').addEventListener('click', function (e) {
      var t = e.target.closest('[data-board-view]');
      if (t) setBoardView(t.getAttribute('data-board-view'));
    });

    $('send').addEventListener('click', function () {
      var text = $('say').value.trim();
      if (!text || !state.projectId) { $('say').focus(); return; }
      $('say').value = '';
      api('/projects/' + encodeURIComponent(state.projectId) + '/discuss',
          { method: 'POST', body: { message: text } }).then(refresh, fail);
    });
  }

  function start() {
    var saved = null, theme = null;
    try { saved = window.sessionStorage.getItem('magarine.token'); } catch (e) { /* private mode */ }
    try { theme = window.localStorage.getItem('magarine.theme'); } catch (e) { /* private mode */ }

    applySkin();
    wire();
    setTheme(theme || 'oled');
    setBoardView('board');
    setView(hashView());
    setLive(false, 'the page has not opened a stream yet');
    checkFonts();

    if (!saved) { showGate(); return; }
    state.token = saved;
    hideGate();
    refresh().then(function () { if (state.token) openStream(); });
  }

  // THE POLL. Runs whether or not a stream is open, because the stream carries
  // events and the board carries state, and a dropped stream must not leave
  // the page frozen on a stale board. Four seconds, the interval the previous
  // page used.
  window.setInterval(function () { if (state.token) refresh(); }, POLL_MS);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
