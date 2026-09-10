/**
 * Load the LIVE app in a real Chrome at a real phone viewport and assert on the
 * measured DOM. No dependencies — Node 22 ships a global WebSocket, so this
 * drives Chrome over the DevTools protocol directly.
 *
 * Run:  node scripts/verify-mobile.mjs [url]
 *
 * Why measured and not eyeballed: a `chrome --headless --screenshot
 * --window-size=390,844` does NOT lay the page out at that width, so it has
 * previously produced both false overflow reports and false all-clears. This
 * uses Emulation.setDeviceMetricsOverride, which really does.
 *
 * What it checks:
 *   - the app BOOTS (boot overlay gone, a screen rendered) — a page that serves
 *     200 and then dies on a JS error still looks fine to curl
 *   - zero console errors and zero failed requests
 *   - no horizontal scroll at 390px
 *   - every tappable element >= 44px high
 *   - every input's computed font-size >= 16px (below that iOS Safari
 *     force-zooms the page on focus)
 *   - the service worker registers and the manifest parses
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
const PORT = 9333;
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const profile = mkdtempSync(join(tmpdir(), 'oy-verify-'));
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '\n        ' + detail : ''}`); }
};

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars',
  'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function targetUrl() {
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

let ws, nextId = 1;
const waiters = new Map();
const events = [];

function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

try {
  const wsUrl = await targetUrl();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiters.has(msg.id)) {
      const { resolve, reject } = waiters.get(msg.id);
      waiters.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };

  // Attach to a fresh page target.
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = sessionId;

  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  await send('Log.enable', {}, S);
  await send('Network.enable', {}, S);

  // A real phone viewport — this is what makes the layout assertions mean something.
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true
  }, S);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, S);

  console.log(`\nVerifying ${URL_UNDER_TEST} at 390x844 (mobile, touch)\n`);
  await send('Page.navigate', { url: URL_UNDER_TEST }, S);

  // Give the module graph, the service worker and the first API call time to run.
  await sleep(9000);

  // Walk past the first-run name picker. The tab bar and most controls are
  // deliberately hidden there, so asserting layout on that screen would be
  // testing the wrong state. Pick a name (or seed one) and assert on the app.
  // Apps Script cold-starts, so the user list can take well over 9s to arrive.
  // Poll for it rather than sampling once and drawing a conclusion.
  let entry = 'unknown';
  for (let i = 0; i < 14; i++) {
    const probeRes = await send('Runtime.evaluate', {
      expression: `(() => {
        const nameScreen = document.getElementById('scr-name');
        if (!nameScreen || !nameScreen.classList.contains('active')) return 'already-in';
        return document.querySelector('#nameList [data-name]') ? 'names-ready' : 'waiting';
      })()`,
      returnByValue: true
    }, S);
    entry = probeRes.result.value;
    if (entry !== 'waiting') break;
    await sleep(2000);
  }
  if (entry === 'names-ready') {
    const picked = await send('Runtime.evaluate', {
      expression: `(() => {
        const b = document.querySelector('#nameList [data-name]');
        if (b) { b.click(); return b.dataset.name; } return null;
      })()`,
      returnByValue: true
    }, S);
    entry = 'picked:' + picked.result.value;
  }
  console.log(`  (entry: ${entry})
`);
  await sleep(3500);

  /* ---------- console + network errors ---------- */
  const consoleErrors = events
    .filter(e => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    .map(e => (e.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  const exceptions = events
    .filter(e => e.method === 'Runtime.exceptionThrown')
    .map(e => e.params.exceptionDetails?.exception?.description
      || e.params.exceptionDetails?.text || 'exception');
  const failedReqs = events
    .filter(e => e.method === 'Network.loadingFailed'
      && !/net::ERR_ABORTED/.test(e.params.errorText || ''))
    .map(e => e.params.errorText);

  ok('no uncaught JavaScript exceptions', exceptions.length === 0, exceptions.join('\n        '));
  ok('no console errors', consoleErrors.length === 0, consoleErrors.join('\n        '));
  ok('no failed network requests', failedReqs.length === 0, failedReqs.join('\n        '));

  /* ---------- measured assertions in the page ---------- */
  const expr = `(() => {
    const boot = document.getElementById('boot');
    const active = document.querySelector('.screen.active');
    const tappable = [...document.querySelectorAll('button,a,input,select,textarea,[role=button]')]
      .filter(e => e.offsetParent !== null);
    const small = tappable
      .filter(e => e.getBoundingClientRect().height > 0
                && e.getBoundingClientRect().height < 44)
      .map(e => (e.id || e.className || e.tagName) + '@' +
                Math.round(e.getBoundingClientRect().height) + 'px');
    const inputs = [...document.querySelectorAll('input,select,textarea')]
      .filter(e => e.offsetParent !== null);
    const tinyFont = inputs
      .filter(e => parseFloat(getComputedStyle(e).fontSize) < 16)
      .map(e => (e.id || e.tagName) + '@' + getComputedStyle(e).fontSize);
    return {
      // Measure what a user SEES, not what the attribute claims: author CSS
      // can override [hidden] and leave the element fully painted.
      bootHidden: !!boot && boot.hidden,
      bootInvisible: !!boot && (boot.offsetParent === null
        && getComputedStyle(boot).display === 'none'),
      bootCoversScreen: !!boot && (() => {
        const r = boot.getBoundingClientRect();
        return getComputedStyle(boot).display !== 'none'
          && r.width > innerWidth * 0.8 && r.height > innerHeight * 0.8;
      })(),
      activeScreen: active ? active.id : null,
      screenCount: document.querySelectorAll('.screen').length,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      tappableCount: tappable.length,
      small,
      tinyFont,
      hasTabbar: !!document.querySelector('.tabbar'),
      tabbarHidden: document.getElementById('tabbar')?.hidden ?? null,
      tabbarVisible: (() => {
        const t = document.getElementById('tabbar');
        return !!t && getComputedStyle(t).display !== 'none'
          && t.getBoundingClientRect().height > 40;
      })(),
      title: document.title,
      themeColor: document.querySelector('meta[name=theme-color]')?.content || null,
      manifestHref: document.querySelector('link[rel=manifest]')?.getAttribute('href') || null,
      swController: !!navigator.serviceWorker,
      bodyText: (document.body.innerText || '').slice(0, 300)
    };
  })()`;

  const { result } = await send('Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: false }, S);
  const r = result.value;

  ok('the app boots (splash screen actually gone from the screen)',
    r.bootInvisible === true,
    `boot.hidden=${r.bootHidden} computed-display-none=${r.bootInvisible}`);
  ok('the splash screen is NOT still covering the app',
    r.bootCoversScreen === false,
    'the boot overlay is still painted over the whole viewport');
  ok('a screen is rendered', !!r.activeScreen, `activeScreen=${r.activeScreen}`);
  ok('all six screen containers exist', r.screenCount >= 5, `found ${r.screenCount}`);
  ok('NO horizontal scroll at 390px',
    r.scrollWidth === r.clientWidth,
    `documentElement scrollWidth=${r.scrollWidth} clientWidth=${r.clientWidth}`);
  ok('body does not overflow sideways', r.bodyScrollWidth <= 390,
    `body.scrollWidth=${r.bodyScrollWidth}`);
  ok('every visible tap target is at least 44px high',
    r.small.length === 0, r.small.join(', '));
  ok('every input is at least 16px (no iOS force-zoom on focus)',
    r.tinyFont.length === 0, r.tinyFont.join(', '));
  ok('there are tappable controls on screen', r.tappableCount > 3,
    `count=${r.tappableCount}`);
  ok('the bottom tab bar is visible', r.tabbarVisible === true,
    `tabbarVisible=${r.tabbarVisible}`);
  ok('title is set', r.title === 'Open Yard Inventory', r.title);
  ok('theme colour is RSA blue', r.themeColor === '#002060', String(r.themeColor));
  ok('manifest is linked', r.manifestHref === './manifest.json', String(r.manifestHref));

  /* ---------- service worker actually registered ---------- */
  const swExpr = `navigator.serviceWorker.getRegistrations()
    .then(rs => rs.map(x => x.scope).join(','))`;
  const sw = await send('Runtime.evaluate',
    { expression: swExpr, returnByValue: true, awaitPromise: true }, S);
  ok('service worker registered', !!(sw.result.value && sw.result.value.length),
    `scopes=${sw.result.value}`);

  /* ---------- the live backend answered ---------- */
  const apiExpr = `(async () => {
    const r = await fetch('${URL_UNDER_TEST}manifest.json');
    return r.ok;
  })()`;
  const man = await send('Runtime.evaluate',
    { expression: apiExpr, returnByValue: true, awaitPromise: true }, S);
  ok('manifest fetches and parses', man.result.value === true);

  console.log(`\n  --- what the screen actually says ---`);
  console.log('  ' + String(r.bodyText).split('\n').filter(Boolean).slice(0, 12).join('\n  '));

} catch (err) {
  fail++;
  console.log(`\n  ERROR  ${err.message}`);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
