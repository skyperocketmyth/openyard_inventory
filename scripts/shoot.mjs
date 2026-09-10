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

/**
 * Normalised to a directory URL. Every use below concatenates a path onto this,
 * so a caller passing `.../index.html` (or omitting the trailing slash) would
 * otherwise silently build `index.htmlmanifest.json` and fail a check that has
 * nothing to do with what it is testing.
 */
const URL_UNDER_TEST = (u => {
  if (!u) return 'https://skyperocketmyth.github.io/openyard_inventory/';
  const stripped = u.replace(/(?:index\.html)?(?:[?#].*)?$/, '');
  return stripped.endsWith('/') ? stripped : stripped + '/';
})(process.argv[2]);
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

  const REAL = process.argv.includes('--real');

  // Seed SAMPLE data into this throwaway browser's own storage — never into the
  // real Sheet. The app renders from cache first, so this is enough to show the
  // screens populated, and the live data is left untouched.
  if (!REAL) await evalIn(`(async () => {
    const SAMPLE_ITEMS = [
      { sku:'TMT-12MM',  description:'TMT Steel Bar 12mm x 12m', uom:'PCS', active:true, rev:1 },
      { sku:'PLY-18-BR', description:'Plywood Sheet 18mm Brown', uom:'PCS', active:true, rev:1 },
      { sku:'AGG-20MM',  description:'Aggregate 20mm',           uom:'MT',  active:true, rev:1 },
      { sku:'CEM-OPC-50',description:'Cement OPC 50kg bag',      uom:'BAG', active:true, rev:1 },
      { sku:'SCAF-TUBE', description:'Scaffold Tube 6m',         uom:'PCS', active:true, rev:1 }
    ];
    const SAMPLE_BAL = [
      { sku:'TMT-12MM',   total:350,  damaged:12, lastTxnTs:'2026-09-09T09:02:00.000Z' },
      { sku:'PLY-18-BR',  total:80,   damaged:18, lastTxnTs:'2026-09-09T08:40:00.000Z' },
      { sku:'AGG-20MM',   total:1200, damaged:0,  lastTxnTs:'2026-09-08T14:15:00.000Z' },
      { sku:'CEM-OPC-50', total:640,  damaged:35, lastTxnTs:'2026-09-09T07:20:00.000Z' },
      { sku:'SCAF-TUBE',  total:210,  damaged:0,  lastTxnTs:'2026-09-07T11:05:00.000Z' }
    ];
    const db = await new Promise(res => {
      const r = indexedDB.open('oy_db', 1);
      r.onsuccess = () => res(r.result);
    });
    const put = (key, value) => new Promise(res => {
      const t = db.transaction('cache', 'readwrite');
      t.objectStore('cache').put({ key, value, fetchedTs: new Date().toISOString() });
      t.oncomplete = res;
    });
    await put('items', SAMPLE_ITEMS);
    await put('balances', SAMPLE_BAL);
    await put('users', ['Rakesh Kumar','Suresh Nair','Anil Joseph']);
    await put('meta', { epoch: 99, itemsEpoch: 99, lastSyncTs: new Date().toISOString() });
    localStorage.setItem('oy_user', 'Rakesh Kumar');
    localStorage.setItem('oy_recent', JSON.stringify(['TMT-12MM','PLY-18-BR']));
    return true;
  })()`);

  // Offline, so the cached sample data is what renders and the live Sheet is
  // never contacted. It also puts the offline indicator on screen, which is
  // worth seeing.
  if (!REAL) {
    await send('Network.enable', {}, S);
    await send('Network.emulateNetworkConditions',
      { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, S);
    await send('Page.navigate', { url: URL_UNDER_TEST }, S);
    await sleep(6000);
  } else {
    // Live: pick the first real name and let the real data load.
    await evalIn(`(() => {
      const b = document.querySelector('#nameList [data-name]');
      if (b) b.click(); return true;
    })()`);
    await sleep(4000);
  }
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
