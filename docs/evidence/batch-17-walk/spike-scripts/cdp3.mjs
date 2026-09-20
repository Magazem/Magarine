// Grant notifications for MY spike origin and KEEP the session open (overrides last only while the DevTools session lives),
// click the page button with a user gesture, hold for N seconds, exit. Not product code.
const [port, origin, hold] = [process.argv[2], process.argv[3], Number(process.argv[4] || 14)];
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith(origin));
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const open = (u) => new Promise((res, rej) => { const w = new WebSocket(u); w.onopen = () => res(w); w.onerror = rej; });
let id = 0;
const call = (ws, method, params = {}) => { const my = ++id; return new Promise((res) => { const h = (m) => { const d = JSON.parse(m.data); if (d.id === my) { ws.removeEventListener('message', h); res(d); } }; ws.addEventListener('message', h); ws.send(JSON.stringify({ id: my, method, params })); }); };
const b = await open(version.webSocketDebuggerUrl);
console.log('grant', JSON.stringify(await call(b, 'Browser.grantPermissions', { origin, permissions: ['notifications'] })));
const p = await open(page.webSocketDebuggerUrl);
console.log('click', JSON.stringify(await call(p, 'Runtime.evaluate', { expression: "document.getElementById('notify').click(); Notification.permission", userGesture: true, returnByValue: true })));
setTimeout(() => process.exit(0), hold * 1000);
