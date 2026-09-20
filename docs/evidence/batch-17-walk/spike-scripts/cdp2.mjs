// Evaluate an expression in MY spike page over MY debug port (user gesture). Not product code.
const [port, origin, expr] = [process.argv[2], process.argv[3], process.argv[4]];
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith(origin));
if (!page) { console.log('no page target'); process.exit(2); }
const ws = await new Promise((res, rej) => { const w = new WebSocket(page.webSocketDebuggerUrl); w.onopen = () => res(w); w.onerror = rej; });
const out = await new Promise((res) => { ws.onmessage = (m) => res(JSON.parse(m.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, userGesture: true, returnByValue: true, awaitPromise: true } })); });
console.log(JSON.stringify(out.result));
process.exit(0);
