// Batch 11 item 3 (docs/strategy/batch-11-spec.md section 2, batch 10
// addendum): the browser page, served by daemonApi.ts's `GET /` (the one
// unauthenticated route -- see that file's comment on why). Plain HTML and
// a single inline <script>, no framework, no build step -- this string IS
// the shipped artefact, loaded straight off disk the same way every other
// .ts file in this project is, never bundled or transpiled.
//
// Auth: the token is typed in once and kept in sessionStorage (cleared when
// the tab closes) -- never a cookie, never in the URL, never sent anywhere
// but as the Authorization header on this page's own fetch() calls to the
// daemon it was loaded from.
//
// The conversation panel's message box is explicitly wired to nothing yet
// (see the `sendMessage` handler below): Part 2, after Role R's
// `discussProject` lands, wires it to a real POST /projects/{id}/discuss.
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Magarine</title>
<style>
  body { font-family: ui-monospace, Consolas, monospace; margin: 0; padding: 1rem; background: #111; color: #ddd; }
  h1, h2 { font-weight: normal; }
  h1 { font-size: 1.1rem; }
  h2 { font-size: 0.95rem; border-bottom: 1px solid #444; padding-bottom: 0.25rem; margin-top: 1.5rem; }
  input, select, textarea, button { font-family: inherit; font-size: 0.9rem; background: #222; color: #ddd; border: 1px solid #555; padding: 0.3rem; }
  button { cursor: pointer; }
  button:hover { background: #333; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  td, th { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid #333; vertical-align: top; }
  .row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.5rem; }
  .paused { background: #4a1c1c; border: 1px solid #a33; padding: 0.5rem; margin: 0.5rem 0; white-space: pre-wrap; }
  .inbox-item { border: 1px solid #444; padding: 0.5rem; margin-bottom: 0.5rem; }
  .inbox-item .message { white-space: pre-wrap; margin: 0.3rem 0; }
  .error { color: #f88; }
  .muted { color: #888; font-size: 0.8rem; }
  pre.scope { white-space: pre-wrap; background: #1a1a1a; border: 1px solid #333; padding: 0.5rem; max-height: 20rem; overflow: auto; }
</style>
</head>
<body>
<h1>Magarine</h1>

<div class="row">
  <label>Daemon token: <input id="token" type="password" size="40" placeholder="paste the token magarine serve printed"></label>
  <button id="saveToken">Save</button>
  <span id="tokenStatus" class="muted"></span>
</div>

<div class="row">
  <label>Project: <select id="projectSelect"><option value="">-- select --</option></select></label>
  <button id="refreshProjects">Refresh projects</button>
  <button id="refreshNow">Refresh now</button>
  <span id="lastRefresh" class="muted"></span>
</div>

<div id="errorBox" class="error"></div>
<div id="pausedBox"></div>

<h2>Board</h2>
<table id="boardTable"><thead><tr><th>id</th><th>status</th><th>title</th><th>attempts</th><th>cost</th><th>blocked by</th><th></th></tr></thead><tbody></tbody></table>

<h2>Inbox</h2>
<div id="inboxList"></div>

<h2>Activity</h2>
<div id="activityList" class="muted"></div>

<h2>Conversation</h2>
<div class="muted">Scope document (read-only here):</div>
<pre class="scope" id="scopeText"></pre>
<div class="row">
  <textarea id="messageBox" rows="2" cols="60" placeholder="Not wired yet -- Part 2 (after the Manager lands) wires this to a real conversation."></textarea>
  <button id="sendMessage">Send</button>
</div>

<script>
(function () {
  'use strict';

  var state = {
    token: sessionStorage.getItem('magarine_token') || '',
    projectId: sessionStorage.getItem('magarine_project') || '',
  };

  var tokenInput = document.getElementById('token');
  var tokenStatus = document.getElementById('tokenStatus');
  var projectSelect = document.getElementById('projectSelect');
  var errorBox = document.getElementById('errorBox');
  var pausedBox = document.getElementById('pausedBox');
  var boardBody = document.querySelector('#boardTable tbody');
  var inboxList = document.getElementById('inboxList');
  var activityList = document.getElementById('activityList');
  var scopeText = document.getElementById('scopeText');
  var lastRefresh = document.getElementById('lastRefresh');

  tokenInput.value = state.token;
  tokenStatus.textContent = state.token ? 'token set for this tab' : 'no token set';

  function showError(message) {
    errorBox.textContent = message || '';
  }

  // Every call to the daemon's real API goes through here, and only here,
  // so the Authorization header is attached exactly once, in exactly one
  // place -- no route call anywhere else in this file constructs its own
  // fetch() headers.
  function api(path, options) {
    options = options || {};
    var headers = options.headers || {};
    headers['Authorization'] = 'Bearer ' + state.token;
    if (options.body) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (res) {
      return res.json().then(function (json) {
        if (!res.ok) {
          throw new Error((json && json.error) || ('request failed: ' + res.status));
        }
        return json;
      });
    });
  }

  function loadProjects() {
    return api('/projects').then(function (projects) {
      var current = projectSelect.value;
      projectSelect.innerHTML = '<option value="">-- select --</option>';
      projects.forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + ' (' + p.id + ')';
        projectSelect.appendChild(opt);
      });
      if (state.projectId) {
        projectSelect.value = state.projectId;
      } else if (current) {
        projectSelect.value = current;
      }
    }).catch(function (err) {
      showError('could not load projects: ' + err.message);
    });
  }

  function renderPaused(board) {
    if (!board.pauseMessage) {
      pausedBox.innerHTML = '';
      return;
    }
    var div = document.createElement('div');
    div.className = 'paused';
    div.textContent = 'PAUSED: ' + board.pauseMessage;
    pausedBox.innerHTML = '';
    pausedBox.appendChild(div);

    var controls = document.createElement('div');
    controls.className = 'row';
    if (board.pauseReason === 'spend_cap') {
      var amount = document.createElement('input');
      amount.type = 'number';
      amount.step = '0.01';
      amount.placeholder = 'new max spend (usd)';
      var raiseBtn = document.createElement('button');
      raiseBtn.textContent = 'Raise cap';
      raiseBtn.onclick = function () {
        var v = Number(amount.value);
        if (!v || v <= 0) { showError('enter a positive max-spend amount first'); return; }
        api('/projects/' + state.projectId + '/set', { method: 'POST', body: { maxSpend: v } })
          .then(refresh)
          .catch(function (err) { showError(err.message); });
      };
      controls.appendChild(amount);
      controls.appendChild(raiseBtn);
    } else {
      var resumeBtn = document.createElement('button');
      resumeBtn.textContent = 'Resume (after logging in with claude)';
      resumeBtn.onclick = function () {
        api('/projects/' + state.projectId + '/resume', { method: 'POST' })
          .then(refresh)
          .catch(function (err) { showError(err.message); });
      };
      controls.appendChild(resumeBtn);
    }
    pausedBox.appendChild(controls);
  }

  function renderBoard(board) {
    renderPaused(board);
    boardBody.innerHTML = '';
    board.tickets.forEach(function (t) {
      var tr = document.createElement('tr');
      var kindPrefix = t.kind === 'manager' ? '[MANAGER] ' : '';
      var costText = t.costIsEstimate ? ('at least $' + t.costUsd.toFixed(2) + ', live estimate') : ('$' + t.costUsd.toFixed(2));
      tr.innerHTML =
        '<td>' + t.id + '</td>' +
        '<td>' + t.status + '</td>' +
        '<td>' + kindPrefix + escapeHtml(t.title) + '</td>' +
        '<td>' + t.attemptCount + '/' + t.maxAttempts + '</td>' +
        '<td>' + costText + '</td>' +
        '<td>' + (t.blockedBy || []).join(', ') + '</td>';
      var actionsTd = document.createElement('td');
      if (t.status === 'IN_PROGRESS') {
        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = function () {
          api('/tickets/' + t.id + '/cancel', { method: 'POST' }).then(refresh).catch(function (err) { showError(err.message); });
        };
        actionsTd.appendChild(cancelBtn);
      }
      tr.appendChild(actionsTd);
      boardBody.appendChild(tr);
    });
  }

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : s;
    return div.innerHTML;
  }

  // Inbox reasons are rendered IN FULL, never truncated -- the whole point
  // of this panel (per this batch's brief) is that the owner never has to
  // go somewhere else to read the entire reason.
  function renderInbox(items) {
    inboxList.innerHTML = '';
    if (items.length === 0) {
      inboxList.innerHTML = '<div class="muted">(inbox is empty)</div>';
      return;
    }
    items.forEach(function (item) {
      var div = document.createElement('div');
      div.className = 'inbox-item';

      var header = document.createElement('div');
      header.textContent = (item.ticketId || item.projectId) + '  [' + item.eventType + ']';
      div.appendChild(header);

      var message = document.createElement('div');
      message.className = 'message';
      message.textContent = item.message;
      div.appendChild(message);

      var controls = document.createElement('div');
      controls.className = 'row';

      if (item.ticketId) {
        if (item.eventType === 'worker_needs_user_decision') {
          var answer = document.createElement('input');
          answer.type = 'text';
          answer.placeholder = 'your answer';
          var decideBtn = document.createElement('button');
          decideBtn.textContent = 'Answer';
          decideBtn.onclick = function () {
            api('/tickets/' + item.ticketId + '/decide', { method: 'POST', body: { answer: answer.value } })
              .then(refresh).catch(function (err) { showError(err.message); });
          };
          controls.appendChild(answer);
          controls.appendChild(decideBtn);
        } else if (item.eventType === 'worker_needs_review') {
          var approveBtn = document.createElement('button');
          approveBtn.textContent = 'Approve';
          approveBtn.onclick = function () {
            api('/tickets/' + item.ticketId + '/approve', { method: 'POST' }).then(refresh).catch(function (err) { showError(err.message); });
          };
          var reason = document.createElement('input');
          reason.type = 'text';
          reason.placeholder = 'reject reason';
          var rejectBtn = document.createElement('button');
          rejectBtn.textContent = 'Reject';
          rejectBtn.onclick = function () {
            api('/tickets/' + item.ticketId + '/reject', { method: 'POST', body: { reason: reason.value } })
              .then(refresh).catch(function (err) { showError(err.message); });
          };
          controls.appendChild(approveBtn);
          controls.appendChild(reason);
          controls.appendChild(rejectBtn);
        } else if (item.eventType === 'worker_failed_final') {
          var retryBtn = document.createElement('button');
          retryBtn.textContent = 'Retry';
          retryBtn.onclick = function () {
            api('/tickets/' + item.ticketId + '/retry', { method: 'POST' }).then(refresh).catch(function (err) { showError(err.message); });
          };
          controls.appendChild(retryBtn);
        }
      }

      if (controls.childNodes.length > 0) div.appendChild(controls);
      inboxList.appendChild(div);
    });
  }

  function renderActivity(events) {
    activityList.innerHTML = '';
    events.slice(-30).reverse().forEach(function (e) {
      var div = document.createElement('div');
      div.textContent = e.createdAt + '  ' + e.eventType + '  ' + (e.entityId || '');
      activityList.appendChild(div);
    });
  }

  function renderScope(text) {
    scopeText.textContent = text || '(no scope document set for this project yet)';
  }

  function refresh() {
    if (!state.token || !state.projectId) return;
    showError('');
    Promise.all([
      api('/board?project=' + encodeURIComponent(state.projectId)),
      api('/inbox?project=' + encodeURIComponent(state.projectId)),
      api('/activity?project=' + encodeURIComponent(state.projectId) + '&all=true'),
      api('/projects/' + encodeURIComponent(state.projectId) + '/scope'),
    ]).then(function (results) {
      renderBoard(results[0]);
      renderInbox(results[1]);
      renderActivity(results[2]);
      renderScope(results[3].scopeText);
      lastRefresh.textContent = 'last refreshed ' + new Date().toLocaleTimeString();
    }).catch(function (err) {
      showError(err.message);
    });
  }

  document.getElementById('saveToken').onclick = function () {
    state.token = tokenInput.value;
    sessionStorage.setItem('magarine_token', state.token);
    tokenStatus.textContent = state.token ? 'token set for this tab' : 'no token set';
    loadProjects();
  };

  document.getElementById('refreshProjects').onclick = loadProjects;
  document.getElementById('refreshNow').onclick = refresh;

  projectSelect.onchange = function () {
    state.projectId = projectSelect.value;
    sessionStorage.setItem('magarine_project', state.projectId);
    refresh();
  };

  // Explicitly wired to nothing yet: Part 2 (after Role R's discussProject
  // lands) replaces this with a real POST /projects/{id}/discuss call. Until
  // then this box exists only to show the reader where the conversation
  // will go, and says so plainly rather than pretending to work.
  document.getElementById('sendMessage').onclick = function () {
    showError('The message box is not wired to anything yet -- this lands in part 2, once the Manager\\'s discuss route is live.');
  };

  if (state.token) loadProjects();
  setInterval(refresh, 4000);
})();
</script>
</body>
</html>
`;
