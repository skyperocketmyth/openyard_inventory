/**
 * Prove that a saved entry does NOT revert.
 *
 * Run:  node scripts/verify-no-revert.mjs [url]
 *
 * The bug this exists to catch, in the exact order it happened:
 *
 *   1. tap Save. The entry goes in the outbox and the screen shows the new
 *      figure, because `projected()` counts queued entries.
 *   2. the background upload succeeds and DELETES the entry from the outbox.
 *   3. the balances the server replied with were discarded, so `state.balances`
 *      still holds the PRE-write figure.
 *   4. the next repaint therefore shows the OLD number. It jumps backwards a
 *      second or two after saving, and it stays wrong until the app is
 *      restarted.
 *
 * Every existing check passed throughout — the entry really was saved, the
 * sheet really was correct, the layout was fine. Only driving a real save and
 * then WAITING for the upload to land catches it, which is why this file drives
 * a real browser instead of unit-testing the projection.
 *
 * Uses a throwaway `ZZTEST-` code so `action=purgeTestData` can clean up, and
 * purges on the way out even if an assertion failed.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_UNDER_TEST = (u => {
  if (!u) return 'https://skyperocketmyth.github.io/openyard_inventory/';
  const stripped = u.replace(/(?:index\.html)?(?:[?#].*)?$/, '');
  return stripped.endsWith('/') ? stripped : stripped + '/';
})(process.argv[2]);

const EXEC = readFileSync('.exec_url', 'utf8').trim();
const SKU = 'ZZTEST-REVERT';
const USER = 'Harish';
const QTY = 7;
const PORT = 9337;
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const profile = mkdtempSync(join(tmpdir(), 'oy-revert-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '\n        ' + detail : ''}`); }
};

/** Apps Script serves HTML error pages at HTTP 200, so retry on non-JSON. */
async function call(url, init, label) {
  let last = '';
  for (let i = 0; i < 5; i++) {
    if (i) await sleep(1500 * i);
    try {
      const r = await fetch(url, { ...init, redirect: 'follow' });
      last = await r.text();
      return JSON.parse(last);
    } catch { /* HTML instead of JSON — retry */ }
  }
  throw new Error(`${label}: server never returned JSON (last: ${last.slice(0, 90)})`);
}
const post = (action, payload) => call(`${EXEC}?action=${action}`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: JSON.stringify(payload)
}, action);
const get = action => call(`${EXEC}?action=${action}`, { method: 'GET' }, action);

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  'about:blank'
], { stdio: 'ignore' });

let ws, nextId = 1, S;
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
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debugging endpoint');
}
const run = async expression => {
  const r = await send('Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true }, S);
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description
      || r.exceptionDetails.text || 'evaluate threw');
  }
  return r.result?.value;
};

/**
 * The Receive screen's context strip: "In yard now - N total ...".
 *
 * The page returns RAW TEXT and the number is parsed here in Node, deliberately.
 * An earlier version injected a regex into the page inside a template literal,
 * where \d is not a valid escape and collapses to a bare "d" — so the filter
 * stripped every character that was not a "d", Number('') came back as 0, and
 * the test reported a REVERTED figure that was in fact correct all along. It
 * cost a full debugging cycle. Keep regexes on this side of the CDP boundary.
 */
const digits = t => {
  if (t === null || t === undefined) return null;
  const m = String(t).match(/(-?[\d,]+)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
};

const readTotal = async () => {
  const t = await run(`(() => {
    const c = document.getElementById('rcvCtx');
    return (!c || c.hidden) ? null : c.textContent;
  })()`);
  if (t === null) return null;
  const m = String(t).match(/([\d,]+)\s*total/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
};

const syncText = () => run(
  `(document.getElementById('syncText') || {}).textContent || ''`);

/**
 * Read the total off the STOCK screen, having navigated there fresh.
 *
 * This has to force a real repaint, and that is the whole reason it exists.
 * Reading the Receive screen after the upload lands proves nothing: with the
 * fix removed, nothing repaints that screen, so the stale DOM still shows the
 * correct figure and the test passes against broken code. It did — this file's
 * first version was hollow. The bug only appears on the NEXT paint, which is
 * exactly what a user triggers by going to look at the stock list.
 */
const readBalanceTotal = async () => {
  await run(`document.querySelector('.tab[data-screen="balance"]').click()`);
  await sleep(700);
  await run(`(() => {
    const s = document.getElementById('balSearch');
    s.value = ${JSON.stringify(SKU)};
    s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(800);                       // the balance search is debounced
  const t = await run(`(() => {
    const row = document.querySelector('#balList [data-sku="${SKU}"]');
    if (!row) return null;
    const v = row.querySelector('.row-num .v');
    return v ? v.textContent : null;
  })()`);
  return digits(t);
};

console.log(`\nNo-revert regression test against ${URL_UNDER_TEST}`);
console.log(`Throwaway code ${SKU}, receiving ${QTY}\n`);

try {
  // WARM THE BACKEND FIRST. Apps Script cold-starts, and a cold start is slower
  // than any sane in-browser boot timeout — which made this test a coin flip
  // that failed at "the app boots" and proved nothing either way. Ping until it
  // answers quickly, THEN start the browser, so a failure below is about the
  // app and not about Google waking up.
  // Warm on `bootstrap`, NOT `ping`. Bootstrap is what the app actually calls
  // on open — it reads five tabs — and a fast `ping` says nothing about it.
  // Warming on ping let the browser hit a still-cold bootstrap and time out,
  // which failed this test at "the app boots" and proved nothing.
  let warm = 0, users = 0;
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    try {
      const b = await get('bootstrap');
      users = (((b || {}).data || {}).users || []).length;
    } catch { /* keep trying */ }
    warm = Date.now() - t0;
    if (users > 0 && warm < 4000) break;
    await sleep(1000);
  }
  console.log(`  backend warm (bootstrap ${warm}ms, ${users} users)`);
  if (!users) {
    throw new Error('the server returned no users — the app cannot get past its '
      + 'name picker, so nothing below would be testable');
  }

  await post('upsertItem', {
    sku: SKU, description: 'No-revert regression test', uom: 'PCS', recordedBy: USER
  });

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
  S = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S);

  await send('Page.navigate', { url: URL_UNDER_TEST }, S);

  // Apps Script cold-starts, so poll for the name list rather than guessing.
  let state = 'waiting';
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    state = await run(`(() => {
      const scr = document.getElementById('scr-name');
      if (!scr) return 'no-app';
      if (!scr.classList.contains('active')) return 'already-in';
      return document.querySelector('#nameList [data-name]') ? 'names-ready' : 'waiting';
    })()`);
    if (state !== 'waiting') break;
  }
  ok('the app boots and loads its data', state === 'names-ready' || state === 'already-in',
    `state=${state}`);
  if (state !== 'names-ready' && state !== 'already-in') {
    // Everything below depends on this. Reporting six more failures would look
    // like six defects instead of one environment problem.
    throw new Error(`the app never loaded its data (state=${state}) — `
      + 'backend unreachable from this origin, or still cold. Nothing below was tested.');
  }

  if (state === 'names-ready') {
    await run(`document.querySelector('#nameList [data-name]').click()`);
    await sleep(600);
  }

  // Receive tab -> open the item picker -> choose the throwaway code.
  await run(`document.querySelector('.tab[data-screen="receive"]').click()`);
  await sleep(600);
  await run(`document.getElementById('rcvItem').click()`);
  await sleep(500);
  await run(`(() => {
    const s = document.getElementById('pkSearch');
    s.value = ${JSON.stringify(SKU)};
    s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(700);                       // the picker search is debounced
  const picked = await run(`(() => {
    const r = document.querySelector('#pkList [data-pick="${SKU}"]')
           || document.querySelector('#pkList [data-pick]');
    if (!r) return null;
    r.click(); return r.dataset.pick;
  })()`);
  ok('the throwaway item can be selected on Receive', picked === SKU, `picked=${picked}`);
  await sleep(700);

  const before = await readTotal();
  ok('the Receive screen shows a starting figure', before !== null, `read ${before}`);

  // Record the receipt the way a user does: type a quantity, tap Save.
  await run(`(() => {
    const q = document.getElementById('rcvQty');
    q.value = '${QTY}';
    q.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(500);
  await run(`document.getElementById('rcvSubmit').click()`);
  await sleep(900);

  const immediately = await readTotal();
  ok('the figure rises the moment it is saved',
    immediately === before + QTY, `expected ${before + QTY}, got ${immediately}`);

  // Wait for the upload to actually LAND — which is the moment the entry is
  // deleted from the queue, and the moment the old code lost the figure.
  //
  // Asked of the SERVER, not of the sync pill. The pill is a rendering
  // artefact: it repaints from an async listener whose promise nobody awaits,
  // so it can lag the real queue state and made this check flap between runs
  // while the actual behaviour was correct.
  let landed = false;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try {
      const b = await get('getBalances');
      const row = ((b.data || {}).balances || []).find(x => x.sku === SKU);
      if (row && Number(row.total) === before + QTY) { landed = true; break; }
    } catch { /* keep waiting */ }
  }
  ok('the upload reaches the server', landed,
    `server never showed ${before + QTY} for ${SKU}`);

  // Now go and LOOK at the stock list, which forces a fresh paint from the
  // projection. This is the moment the old code showed the wrong number.
  const after = await readBalanceTotal();
  ok('the stock list does NOT revert after the upload lands',
    after === before + QTY,
    after === null
      ? `the item VANISHED from the stock list — the phone was never told the `
        + `server has it, so it is neither queued nor known. This is the bug.`
      : after === before
        ? `REVERTED to the pre-save figure ${before} — this is the bug`
        : `expected ${before + QTY}, got ${after}`);

  // And the phone agrees with the server, so this is not the phone lying twice.
  const srv = await get('getBalances');
  const srvRow = ((srv.data || {}).balances || []).find(x => x.sku === SKU);
  ok('the phone and the server agree',
    !!srvRow && Number(srvRow.total) === after,
    `server=${srvRow ? srvRow.total : 'no row'}, phone=${after}`);

} catch (err) {
  fail++;
  console.log(`\n  ERROR  ${err.message}`);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  // Always clean up, even after a failure — a stray ZZTEST row in the yard's
  // item list is worse than a failed test.
  try {
    const p = await post('purgeTestData', {});
    console.log(`\n  cleanup: ${JSON.stringify((p && p.data) || p)}`);
  } catch (e) {
    console.log(`\n  cleanup FAILED — remove ${SKU} by hand: ${e.message}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
