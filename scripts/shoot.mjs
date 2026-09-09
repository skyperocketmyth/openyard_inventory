/**
 * Capture screenshots of the live app at a phone viewport, one per screen, so
 * the UI can actually be looked at rather than assumed from passing assertions.
 *
 * Run:  node scripts/shoot.mjs [url] [outDir]
 *
 * Drives real Chrome over the DevTools protocol (Node 22's global WebSocket),
 * seeding a user and a couple of items into browser storage first so the
 * screens have something in them.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_UNDER_TEST = process.argv[2]
  || 'https://skyperocketmyth.github.io/openyard_inventory/';
const OUT = process.argv[3] || join(process.cwd(), 'shots');
const PORT = 9334;
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'oy-shoot-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  'about:blank'
], { stdio: 'ignore' });

let ws, nextId = 1;
const waiters = new Map();
function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

async function endpoint() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debugging endpoint');
}

try {
  ws = new WebSocket(await endpoint());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) {
      const { resolve, reject } = waiters.get(m.id);
      waiters.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, S);

  const shoot = async name => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, S);
    const path = join(OUT, `${name}.png`);
    writeFileSync(path, Buffer.from(data, 'base64'));
    console.log(`  ${name}.png`);
  };

  const evalIn = async expression => {
    const r = await send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, S);
    return r.result?.value;
  };

  // First load: the name picker, before any user is chosen.
  await send('Page.navigate', { url: URL_UNDER_TEST }, S);
  await sleep(7000);
  await shoot('01-name-picker');

  // Pick whoever is first in the list so the rest of the app is reachable.
  await evalIn(`(() => {
    const b = document.querySelector('#nameList [data-name]');
    if (b) { b.click(); return b.dataset.name; }
    return null;
  })()`);
  await sleep(2500);
  await shoot('02-balance');

  for (const [screen, shot] of [['receive','03-receive'], ['issue','04-issue'], ['items','05-items']]) {
    await evalIn(`document.querySelector('.tab[data-screen="${screen}"]').click()`);
    await sleep(1200);
    await shoot(shot);
  }

  // An item picked on Receive, with quantities typed in, so the live preview
  // and the "damaged is a subset" device are visible.
  await evalIn(`document.querySelector('.tab[data-screen="receive"]').click()`);
  await sleep(600);
  await evalIn(`(() => {
    const t = document.getElementById('rcvItem'); if (t) t.click(); return true;
  })()`);
  await sleep(1200);
  await shoot('06-item-picker');
  await evalIn(`(() => {
    const r = document.querySelector('#pkList [data-pick]');
    if (r) { r.click(); return r.dataset.pick; } return null;
  })()`);
  await sleep(1200);
  await evalIn(`(() => {
    const q = document.getElementById('rcvQty'), d = document.getElementById('rcvDmg');
    q.value = '100'; q.dispatchEvent(new Event('input', { bubbles: true }));
    d.value = '5';   d.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(900);
  await shoot('07-receive-filled');

  // The balance detail sheet, which carries the TOTAL = GOOD + DAMAGED equation.
  await evalIn(`document.querySelector('.tab[data-screen="balance"]').click()`);
  await sleep(1000);
  const opened = await evalIn(`(() => {
    const r = document.querySelector('#balList [data-sku]');
    if (r) { r.click(); return r.dataset.sku; } return null;
  })()`);
  if (opened) { await sleep(2000); await shoot('08-item-detail'); }

  // The add-item form.
  await evalIn(`(() => { const b=document.getElementById('sheetClose'); if(b) b.click(); return 1; })()`);
  await sleep(500);
  await evalIn(`document.querySelector('.tab[data-screen="items"]').click()`);
  await sleep(800);
  await evalIn(`(() => { const f=document.getElementById('fabAddItem'); if(f) f.click(); return 1; })()`);
  await sleep(1200);
  await shoot('09-add-item');

  console.log(`\nScreenshots in ${OUT}`);
} catch (err) {
  console.error(`ERROR ${err.message}`);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
