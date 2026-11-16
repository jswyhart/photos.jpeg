// Run by ci-smoke.sh: looks inside the app's web view through its debugging port (debug builds
// allow that), reloads the editor while listening for errors, and writes what it finds.
//   node ci-probe.mjs <port> <output.json>      (needs Node 22 for its built-in WebSocket)
// Exits 1 when the editor did not come up or threw while starting.
import { writeFileSync } from 'node:fs';
const [port = '9222', outFile = 'probe.json'] = process.argv.slice(2);
const result = { ok: false, errors: [], console: [] };
const done = (code) => { writeFileSync(outFile, JSON.stringify(result, null, 1)); process.exit(code); };
try {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = pages.find(p => p.type === 'page');
  if (!page) { result.errors.push('no page in the web view'); done(1); }
  result.url = page.url;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not attach to the web view')); });
  let id = 0; const waiting = new Map();
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result || m.error); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; result.errors.push(`${d.text} ${d.exception && d.exception.description || ''} @ ${d.url || ''}:${d.lineNumber}`.slice(0, 500)); }
    else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) result.console.push((m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ')).slice(0, 400));
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') result.console.push(('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || '')).slice(0, 400));
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 30000));
  const ev = await send('Runtime.evaluate', { returnByValue: true, expression: `JSON.stringify({ ready: document.readyState, agent: navigator.userAgent, modules: Object.keys(window.PJ || {}).length, catalog: !!(window.PJ && PJ.Catalog && PJ.Catalog.state), elements: document.querySelectorAll('*').length, buttons: document.querySelectorAll('button').length, size: innerWidth + 'x' + innerHeight, text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400) })` });
  result.page = JSON.parse(ev.result.value);
  result.ok = result.errors.length === 0 && result.page.catalog && result.page.buttons > 5;
  ws.close();
} catch (e) { result.errors.push(String(e && e.message || e)); }
done(result.ok ? 0 : 1);
