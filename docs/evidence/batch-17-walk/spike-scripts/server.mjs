// Batch 17 item zero: a throwaway page server for the window spike. Not product code.
import { createServer } from 'node:http';
import { writeFileSync, appendFileSync } from 'node:fs';

const dir = process.argv[2];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#c0392b"/><text x="32" y="46" font-size="40" text-anchor="middle" fill="#fff" font-family="Segoe UI, sans-serif">M</text></svg>`;
const page = `<!doctype html><html><head><meta charset="utf-8"><title>Magarine spike window</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg"></head>
<body style="font-family:Segoe UI,sans-serif;background:#1e2430;color:#eee;padding:24px">
<h1>Magarine window spike</h1>
<p id="state">permission: <b id="perm"></b></p>
<button id="notify" style="font-size:20px;padding:12px 20px">notify me</button>
<script>
const log = (m) => fetch('/log?m=' + encodeURIComponent(m)).catch(() => {});
document.getElementById('perm').textContent = Notification.permission;
log('loaded permission=' + Notification.permission + ' hash=' + location.hash);
document.getElementById('notify').addEventListener('click', async () => {
  log('button clicked; isTrusted gesture, permission=' + Notification.permission);
  const p = await Notification.requestPermission();
  document.getElementById('perm').textContent = p;
  log('requestPermission -> ' + p);
  if (p !== 'granted') return;
  const n = window.__n = new Notification('Needs You: spike test', { body: 'ticket tkt_spike wants a decision', icon: '/favicon.svg', requireInteraction: true });
  n.onshow = () => log('notification shown');
  n.onerror = () => log('notification error');
  n.onclick = () => { window.focus(); log('notification clicked; focus=' + document.hasFocus()); n.close(); };
});
window.addEventListener('focus', () => log('window focus'));
</script></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/favicon.svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.end(svg);
  } else if (url.pathname === '/log') {
    appendFileSync(dir + '/page.log', new Date().toISOString() + ' ' + url.searchParams.get('m') + '\n');
    res.end('ok');
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end(page);
  }
});
server.listen(0, '127.0.0.1', () => writeFileSync(dir + '/port.txt', String(server.address().port)));
