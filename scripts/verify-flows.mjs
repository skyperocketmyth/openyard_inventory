/**
 * Interaction tests against the LIVE app: drive the real UI in real Chrome and
 * assert on what happens. Layout checks live in verify-mobile.mjs; this file
 * is about flows that involve more than one tap.
 *
 * Run:  node scripts/verify-flows.mjs [url]
 *
 * Exists because "Change name" was silently broken and every static check
 * passed: openSheet pushed a history entry per open and closeSheet popped one,
 * so "close this sheet, now open that one" raced its own history.back() and the
 * new sheet was closed again the instant it appeared. Nothing but driving the
 * actual taps would have caught it.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
const PORT = 9335;
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const profile = mkdtempSync(join(tmpdir(), 'oy-flows-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '\n        ' + detail : ''}`); }
};

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

let S;
const run = async (expression) => {
  const r = await send('Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true }, S);
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description
      || r.exceptionDetails.text || 'evaluate threw');
  }
  return r.result?.value;
};

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
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  S = attached.sessionId;
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, S);

  console.log(`\nInteraction tests against ${URL_UNDER_TEST}\n`);
  await send('Page.navigate', { url: URL_UNDER_TEST }, S);

  // Wait for the user list. Apps Script cold-starts, so poll rather than guess.
  let state = 'waiting';
  for (let i = 0; i < 16; i++) {
    await sleep(2000);
    state = await run(`(() => {
      const scr = document.getElementById('scr-name');
      if (!scr) return 'no-app';
      if (!scr.classList.contains('active')) return 'already-in';
      return document.querySelector('#nameList [data-name]') ? 'names-ready' : 'waiting';
    })()`);
    if (state !== 'waiting') break;
  }
  ok('the name list loads', state === 'names-ready' || state === 'already-in', `state=${state}`);
  if (state === 'waiting' || state === 'no-app') throw new Error(`app never became usable (${state})`);

  /* ---- while loading, the app must not claim there are no names ---- */
  // It used to show "No names in the list yet" during the initial fetch, which
  // is a false statement a user then acts on.
  ok('the loading state never claims the list is empty',
    !(await run(`document.getElementById('nameList').innerText.includes('No names in the list yet')`)),
    'the empty state was shown while names were still loading');

  if (state === 'names-ready') {
    const chosen = await run(`(() => {
      const b = document.querySelector('#nameList [data-name]');
      b.click(); return b.dataset.name;
    })()`);
    await sleep(2500);
    ok('picking a name enters the app', await run(
      `document.getElementById('scr-balance').classList.contains('active')`), `chose ${chosen}`);
    ok('the chosen name is remembered on the device',
      await run(`localStorage.getItem('oy_user') === ${JSON.stringify(chosen)}`));
  }

  /* ---- THE REGRESSION: Change name ---- */
  const flow = await run(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const visible = id => {
      const el = document.getElementById(id);
      return !!el && getComputedStyle(el).display !== 'none';
    };
    const seen = [];
    document.getElementById('userChip').click();
    await wait(600);
    seen.push('accountSheet=' + !!document.getElementById('acChange'));
    if (!document.getElementById('acChange')) return { ok: false, seen };
    document.getElementById('acChange').click();
    await wait(800);
    const confirmStayed = !!document.getElementById('cfYes') && visible('sheetBackdrop');
    seen.push('confirmStayed=' + confirmStayed);
    if (!confirmStayed) return { ok: false, seen };
    document.getElementById('cfYes').click();
    await wait(1200);
    const onPicker = document.getElementById('scr-name').classList.contains('active');
    const cleared = !localStorage.getItem('oy_user');
    const sheetClosed = !visible('sheetBackdrop');
    seen.push('onPicker=' + onPicker, 'nameCleared=' + cleared, 'sheetClosed=' + sheetClosed);
    return { ok: onPicker && cleared && sheetClosed, seen };
  })()`);
  ok('Change name opens a confirmation that STAYS on screen',
    String(flow.seen).includes('confirmStayed=true'), JSON.stringify(flow.seen));
  ok('Change name returns to the picker AND clears the saved name',
    flow.ok === true, JSON.stringify(flow.seen));

  /* ---- a sheet must close cleanly, and only once ---- */
  const closeFlow = await run(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const visible = () =>
      getComputedStyle(document.getElementById('sheetBackdrop')).display !== 'none';
    // Re-enter the app so the header is available.
    const b = document.querySelector('#nameList [data-name]');
    if (b) { b.click(); await wait(1500); }
    document.getElementById('userChip').click();
    await wait(500);
    const opened = visible();
    document.getElementById('sheetClose').click();
    await wait(600);
    const closed = !visible();
    // Reopening must still work — a broken history dance breaks the 2nd open.
    document.getElementById('userChip').click();
    await wait(500);
    const reopened = visible();
    document.getElementById('sheetClose').click();
    await wait(400);
    return { opened, closed, reopened };
  })()`);
  ok('a sheet opens, closes, and REOPENS correctly',
    closeFlow.opened && closeFlow.closed && closeFlow.reopened, JSON.stringify(closeFlow));

  /* ---- the tabs actually switch screens ---- */
  const tabs = await run(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const out = {};
    for (const s of ['receive', 'issue', 'items', 'balance']) {
      document.querySelector('.tab[data-screen="' + s + '"]').click();
      await wait(500);
      out[s] = document.getElementById('scr-' + s).classList.contains('active');
    }
    return out;
  })()`);
  ok('every bottom tab switches to its screen',
    Object.values(tabs).every(Boolean), JSON.stringify(tabs));

} catch (err) {
  fail++;
  console.log(`\n  ERROR  ${err.message}`);
} finally {
  try { ws?.close(); } catch { /* already gone */ }
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
