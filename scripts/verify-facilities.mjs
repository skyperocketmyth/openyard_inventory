/**
 * Drive the warehouse UI in a real Chrome, against SEEDED warehouse data.
 *
 * Run:  node scripts/verify-facilities.mjs [url]     (npm run verify:facilities)
 *       Pair it with `npm run serve` and pass http://127.0.0.1:8787/.
 *
 * Why it seeds rather than using the server: warehouse data only exists after
 * S04 migrates the Sheet. Until then every server this can reach returns no
 * warehouses at all, so the chip row renders hidden and the picker is empty —
 * and the entire S03 surface would go untested at exactly the point it is most
 * likely to be wrong. The seed goes into the throwaway browser profile's own
 * IndexedDB. It NEVER touches the Sheet.
 *
 * The API is blocked (`Network.setBlockedURLs`) so that `bootstrap()` cannot
 * overwrite the seeded warehouse list with the live server's empty one. This
 * file tests the UI, not the API; smoke.mjs tests the API.
 *
 * THE CHECK THAT MATTERS is the F10 one: with YARD A holding 35 good and
 * YARD B holding 260, issuing the across-yard total of 300 from YARD A must be
 * refused. Every seeded figure is chosen so that the aggregate, YARD A's and
 * YARD B's are three DIFFERENT numbers — a test where two of them coincide
 * passes just as happily against code that shows the wrong one.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_UNDER_TEST = (u => {
  const stripped = String(u).replace(/(?:index\.html)?(?:[?#].*)?$/, '');
  return stripped.endsWith('/') ? stripped : stripped + '/';
})(process.argv[2] || 'http://127.0.0.1:8787/');
const PORT = 9337;
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const profile = mkdtempSync(join(tmpdir(), 'oy-fac-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '\n        ' + detail : ''}`); }
};

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  'about:blank'
], { stdio: 'ignore' });

let ws, nextId = 1;
const waiters = new Map();
/**
 * Every protocol event that is not a reply. Collected so the last check can
 * assert on real thrown exceptions.
 *
 * The first version of that check read a `window.__oyErrors` array that this
 * file never created, so it compared `0 === 0` and could not fail. A check that
 * cannot fail is worse than no check: it reads as coverage.
 */
const events = [];
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
    } catch { /* not up */ }
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debugging endpoint');
}
let S;
const run = async expression => {
  const r = await send('Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true }, S);
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description
      || r.exceptionDetails.text || 'evaluate threw');
  }
  return r.result?.value;
};

// Aggregate 300/295 good, YARD A 40/35 good, YARD B 260/260 good — all three
// figures distinct, so a check cannot pass by accident if the code shows the
// wrong one.
const SEED = `(async () => {
  const db = await new Promise(res => {
    const r = indexedDB.open('oy_db', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('outbox')) {
        const s = d.createObjectStore('outbox', { keyPath:'seq', autoIncrement:true });
        s.createIndex('status','status',{unique:false});
        s.createIndex('idemKey','idemKey',{unique:true});
      }
      if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache',{keyPath:'key'});
      if (!d.objectStoreNames.contains('failures')) d.createObjectStore('failures',{keyPath:'seq'});
    };
    r.onsuccess = () => res(r.result);
  });
  const put = (key, value) => new Promise(res => {
    const t = db.transaction('cache','readwrite');
    t.objectStore('cache').put({ key, value, fetchedTs: new Date().toISOString() });
    t.oncomplete = res;
  });
  await put('items', [
    { sku:'STEEL-10', description:'Steel Bar 10mm', uom:'PCS', active:true, rev:1 },
    { sku:'CEM-50',   description:'Cement 50kg',    uom:'BAG', active:true, rev:1 }
  ]);
  await put('facilities', [
    { facility:'YARD A', description:'Main yard',    active:true,  rev:1 },
    { facility:'YARD B', description:"O'BRIEN & CO", active:true,  rev:1 },
    { facility:'YARD C', description:'Shut',         active:false, rev:1 },
    // Open, and holding nothing. It exists so the stock screen's "All items are
    // at zero -> Receive stock" empty state is reachable, which is the route
    // that used to open Receive pre-filled with a DIFFERENT yard.
    { facility:'YARD D', description:'Brand new',    active:true,  rev:1 }
  ]);
  await put('balances_v2', [
    { facility:'YARD A', sku:'STEEL-10', total:40,  damaged:5, lastTxnTs:'2026-09-09T09:00:00.000Z' },
    { facility:'YARD B', sku:'STEEL-10', total:260, damaged:0, lastTxnTs:'2026-09-09T08:00:00.000Z' },
    { facility:'YARD A', sku:'CEM-50',   total:12,  damaged:0, lastTxnTs:'2026-09-09T07:00:00.000Z' }
  ]);
  await put('users', ['Harish']);
  await put('meta', { epoch:9, itemsEpoch:3, facilitiesEpoch:2, lastSyncTs:'2026-09-09T09:00:00.000Z' });
  localStorage.setItem('oy_user','Harish');
  return true;
})()`;

try {
  ws = new WebSocket(await endpoint());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) {
      const { resolve, reject } = waiters.get(m.id);
      waiters.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      events.push(m);
    }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  S = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  await send('Network.enable', {}, S);
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, S);
  // Block the API so bootstrap cannot overwrite the seeded warehouse list with
  // the live server's empty one. We are testing the UI, not the API.
  await send('Network.setBlockedURLs', { urls: ['*script.google.com*'] }, S);

  console.log(`\nWarehouse UI tests against ${URL_UNDER_TEST}\n`);
  await send('Page.navigate', { url: URL_UNDER_TEST }, S);
  await sleep(2500);
  await run(SEED);
  await send('Page.navigate', { url: URL_UNDER_TEST }, S);
  await sleep(6000);

  /* ---- 1. the chip row ---- */
  const chips = await run(`(() => {
    const bar = document.getElementById('balFacs');
    const cs = [...bar.querySelectorAll('[data-fac]')];
    return { hidden: bar.hidden, labels: cs.map(c => c.textContent.trim()),
             values: cs.map(c => c.dataset.fac),
             pressed: cs.filter(c => c.getAttribute('aria-pressed') === 'true').map(c => c.dataset.fac) };
  })()`);
  ok('the warehouse chip row is visible', chips.hidden === false, JSON.stringify(chips));
  ok('chips are All + one per OPEN warehouse, closed yard excluded',
    JSON.stringify(chips.values) === JSON.stringify(['', 'YARD A', 'YARD B', 'YARD D']),
    JSON.stringify(chips.values));
  ok('"All warehouses" is selected by default',
    JSON.stringify(chips.pressed) === JSON.stringify(['']), JSON.stringify(chips.pressed));

  /* ---- 2. All view aggregates; a yard chip does NOT ---- */
  const totals = await run(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const read = sku => {
      const row = document.querySelector('#balList [data-sku="' + sku + '"]');
      if (!row) return null;
      return { total: row.querySelector('.row-num .v').textContent.trim(),
               fac: row.dataset.fac, text: row.innerText.replace(/\\s+/g,' ') };
    };
    const out = {};
    out.all = read('STEEL-10');
    document.querySelector('#balFacs [data-fac="YARD A"]').click(); await wait(700);
    out.a = read('STEEL-10');
    document.querySelector('#balFacs [data-fac="YARD B"]').click(); await wait(700);
    out.b = read('STEEL-10');
    document.querySelector('#balFacs [data-fac=""]').click(); await wait(700);
    return out;
  })()`);
  ok('the All view sums the item across warehouses (300)',
    totals.all?.total === '300', JSON.stringify(totals.all));
  ok('YARD A shows 40, NOT the 300 aggregate',
    totals.a?.total === '40' && totals.a?.fac === 'YARD A', JSON.stringify(totals.a));
  ok('YARD B shows 260, NOT the 300 aggregate',
    totals.b?.total === '260' && totals.b?.fac === 'YARD B', JSON.stringify(totals.b));

  /* ---- 3. THE F10 CHECK: the All view offers no actions ---- */
  const allSheet = await run(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.querySelector('#balList [data-sku="STEEL-10"]').click();
    await wait(800);
    const ids = ['dtRcv','dtIss','dtDmg','dtMove'].filter(i => document.getElementById(i));
    const yards = [...document.querySelectorAll('#dtYards [data-yard]')].map(b => b.dataset.yard);
    return { actionButtons: ids, yards,
             body: document.getElementById('sheetBody').innerText.replace(/\\s+/g,' ').slice(0,200) };
  })()`);
  ok('the All-warehouses sheet offers NO action buttons at all',
    allSheet.actionButtons.length === 0, 'found: ' + JSON.stringify(allSheet.actionButtons));
  ok('the All-warehouses sheet lists each warehouse as a tap target',
    JSON.stringify(allSheet.yards) === JSON.stringify(['YARD B', 'YARD A']), JSON.stringify(allSheet.yards));

  /* ---- 4. tapping a yard gives THAT yard's figures and buttons ---- */
  const yardSheet = await run(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.querySelector('#dtYards [data-yard="YARD A"]').click();
    await wait(800);
    const terms = [...document.querySelectorAll('.equation .term .v')].map(e => e.textContent.trim());
    return { terms,
             has: ['dtRcv','dtIss','dtDmg','dtMove'].filter(i => document.getElementById(i)),
             issDisabled: document.getElementById('dtIss')?.disabled,
             title: document.getElementById('sheetTitle').textContent,
             note: document.querySelector('.fac-note')?.innerText || '' };
  })()`);
  ok('tapping a warehouse shows THAT warehouse: 40 total / 35 good / 5 damaged',
    JSON.stringify(yardSheet.terms) === JSON.stringify(['40','35','5']), JSON.stringify(yardSheet.terms));
  ok('the per-warehouse sheet DOES offer the four actions',
    yardSheet.has.length === 4 && yardSheet.issDisabled === false, JSON.stringify(yardSheet));
  ok('the per-warehouse sheet names the warehouse',
    /YARD A/.test(yardSheet.note), yardSheet.note.slice(0, 120));

  /* ---- 5. Issue entered from the TAB BAR asks fresh (6.B) ---- */
  const fresh = await run(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('sheetClose').click(); await wait(500);
    document.querySelector('.tab[data-screen="issue"]').click(); await wait(800);
    return { placeholder: !!document.querySelector('#issFac .placeholder'),
             facText: document.getElementById('issFac').innerText.replace(/\\s+/g,' '),
             availHidden: document.getElementById('issAvail').hidden,
             submitDisabled: document.getElementById('issSubmit').disabled };
  })()`);
  ok('Issue from the tab bar starts with NO warehouse chosen',
    fresh.placeholder === true, JSON.stringify(fresh));
  ok('Issue cannot be submitted without a warehouse',
    fresh.submitDisabled === true, JSON.stringify(fresh));

  /* ---- 6. the picker fills it in, and the quantity is gated on THAT yard ---- */
  const picked = await run(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('issFac').click(); await wait(700);
    const facs = [...document.querySelectorAll('#fpList [data-fac]')].map(b => b.dataset.fac);
    const pickerOpen = getComputedStyle(document.getElementById('sheetBackdrop')).display !== 'none';
    document.querySelector('#fpList [data-fac="YARD A"]').click(); await wait(800);
    const sheetGone = getComputedStyle(document.getElementById('sheetBackdrop')).display === 'none';
    // choose the item
    document.getElementById('issItem').click(); await wait(700);
    document.querySelector('#pkList [data-pick="STEEL-10"]').click(); await wait(800);
    const avail = document.querySelector('#issAvail .v')?.textContent.trim();
    const q = document.getElementById('issQty');
    const set = v => { q.value = v; q.dispatchEvent(new Event('input', { bubbles:true })); };
    set('300'); await wait(400);
    const over = { disabled: document.getElementById('issSubmit').disabled,
                   err: document.getElementById('issQtyErr').textContent };
    set('35'); await wait(400);
    const okq = { disabled: document.getElementById('issSubmit').disabled,
                  label: document.getElementById('issSubmit').textContent };
    return { facs, pickerOpen, sheetGone, avail, over, okq,
             facText: document.getElementById('issFac').innerText.replace(/\\s+/g,' ') };
  })()`);
  ok('the warehouse picker opens and lists the open warehouses',
    picked.pickerOpen === true && picked.facs.includes('YARD A') && picked.facs.includes('YARD B')
      && !picked.facs.includes('YARD C'), JSON.stringify(picked.facs));
  ok('choosing a warehouse closes the picker and fills the selector in',
    picked.sheetGone === true && /YARD A/.test(picked.facText), JSON.stringify(picked));
  ok("available-to-issue is YARD A's 35 good, not the aggregate 295",
    picked.avail === '35', 'avail=' + picked.avail);
  ok('issuing 300 (the aggregate) from YARD A is REFUSED',
    picked.over.disabled === true && /35/.test(picked.over.err), JSON.stringify(picked.over));
  ok('issuing 35 from YARD A is allowed and the button names the warehouse',
    picked.okq.disabled === false && /YARD A/.test(picked.okq.label), JSON.stringify(picked.okq));

  /* ---- 7. a facility name with & and ' survives the attribute round trip ---- */
  const esc = await run(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('issFac').click(); await wait(700);
    const b = document.querySelector('#fpList [data-fac="YARD B"]');
    const desc = b.querySelector('.row-desc').textContent;
    b.click(); await wait(800);
    return { desc, facText: document.getElementById('issFac').innerText.replace(/\\s+/g,' ') };
  })()`);
  ok("a description containing & and ' renders literally, not as entities",
    esc.desc.includes("O'BRIEN & CO"), JSON.stringify(esc));

  /* ---- 8. the layout rules, measured on the NEW controls ---- */
  const measure = `(() => {
    const tappable = [...document.querySelectorAll('button,a,input,select,textarea,[role=button]')]
      .filter(e => e.offsetParent !== null);
    const small = tappable
      .filter(e => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 44)
      .map(e => (e.id || e.className || e.tagName) + '@' + Math.round(e.getBoundingClientRect().height) + 'px');
    const inputs = [...document.querySelectorAll('input,select,textarea')].filter(e => e.offsetParent !== null);
    const tinyFont = inputs.filter(e => parseFloat(getComputedStyle(e).fontSize) < 16)
      .map(e => (e.id || e.tagName) + '@' + getComputedStyle(e).fontSize);
    return { small, tinyFont, count: tappable.length,
             scrollWidth: document.documentElement.scrollWidth };
  })()`;

  const withChips = await run(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('sheetClose').click(); await wait(500);
    document.querySelector('.tab[data-screen="balance"]').click(); await wait(900);
    return ${measure};
  })()`);
  ok('with the chip row on screen, every tap target is >= 44px',
    withChips.small.length === 0, withChips.small.join(', '));
  ok('with the chip row on screen, every input is >= 16px',
    withChips.tinyFont.length === 0, withChips.tinyFont.join(', '));
  ok('the chip row does not cause horizontal overflow at 390px',
    withChips.scrollWidth <= 390, 'scrollWidth=' + withChips.scrollWidth);

  const withPicker = await run(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.querySelector('.tab[data-screen="receive"]').click(); await wait(700);
    document.getElementById('rcvFac').click(); await wait(800);
    return ${measure};
  })()`);
  ok('with the warehouse picker open, every tap target is >= 44px',
    withPicker.small.length === 0, withPicker.small.join(', '));
  ok('with the warehouse picker open, every input is >= 16px',
    withPicker.tinyFont.length === 0, withPicker.tinyFont.join(', '));

  /* ---- 9. the transfer sheet ---- */
  const transfer = await run(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('sheetClose').click(); await wait(500);
    document.querySelector('.tab[data-screen="balance"]').click(); await wait(800);
    document.querySelector('#balFacs [data-fac="YARD A"]').click(); await wait(700);
    document.querySelector('#balList [data-sku="STEEL-10"]').click(); await wait(800);
    document.getElementById('dtMove').click(); await wait(800);
    const tos = [...document.querySelectorAll('#trToChips [data-to]')].map(b => b.dataset.to);
    const help = document.getElementById('sheetBody').innerText.replace(/\\s+/g,' ');
    document.querySelector('#trToChips [data-to="YARD B"]').click(); await wait(400);
    const q = document.getElementById('trQty');
    const set = v => { q.value = v; q.dispatchEvent(new Event('input', { bubbles:true })); };
    set('40'); await wait(400);
    const over = { disabled: document.getElementById('trSubmit').disabled,
                   err: document.getElementById('trErr').textContent };
    set('30'); await wait(500);
    const okq = { disabled: document.getElementById('trSubmit').disabled,
                  label: document.getElementById('trSubmit').textContent,
                  preview: document.getElementById('trPreview').innerText.replace(/\\s+/g,' ') };
    const m = ${measure};
    return { tos, help: help.slice(0,160), over, okq, small: m.small, tinyFont: m.tinyFont };
  })()`);
  // Every OPEN warehouse except the source. YARD C is closed, so it is not a
  // destination; YARD D holds nothing, which is exactly when you would move
  // stock into it, so it must be offered.
  ok('Move stock offers every OTHER open warehouse as a destination',
    JSON.stringify(transfer.tos) === JSON.stringify(['YARD B', 'YARD D']),
    JSON.stringify(transfer.tos));
  ok("moving more than YARD A's 35 good is REFUSED",
    transfer.over.disabled === true && /35/.test(transfer.over.err), JSON.stringify(transfer.over));
  ok('moving 30 is allowed and the preview shows BOTH ends changing',
    transfer.okq.disabled === false && /YARD A/.test(transfer.okq.preview)
      && /YARD B/.test(transfer.okq.preview), JSON.stringify(transfer.okq));
  ok('the transfer sheet meets the tap-target and font rules',
    transfer.small.length === 0 && transfer.tinyFont.length === 0,
    JSON.stringify({ small: transfer.small, tinyFont: transfer.tinyFont }));

  /* ---- 10. REGRESSION: an empty yard's "Receive stock" must not inherit ---- */
  // The bug this pins: `show('receive')` from the stock screen's empty state
  // carried whatever warehouse the LAST action used. On a yard the screen had
  // just described as empty, the form opened pre-filled with a different yard,
  // one tap from filing a receipt against it. Only the tab bar cleared the
  // warehouse; every other route inherited. `show()` now clears by default.
  const inherit = await run(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const closeIfOpen = async () => {
      if (getComputedStyle(document.getElementById('sheetBackdrop')).display !== 'none') {
        document.getElementById('sheetClose').click(); await wait(500);
      }
    };
    await closeIfOpen();
    // 1. take an action at YARD A so a warehouse is in hand
    document.querySelector('.tab[data-screen="balance"]').click(); await wait(800);
    document.querySelector('#balFacs [data-fac="YARD A"]').click(); await wait(700);
    document.querySelector('#balList [data-sku="STEEL-10"]').click(); await wait(800);
    document.getElementById('dtRcv').click(); await wait(900);
    const carried = document.getElementById('rcvFac').innerText.replace(/\\s+/g,' ');
    // 2. now go to an EMPTY yard and use its own "Receive stock" button
    document.querySelector('.tab[data-screen="balance"]').click(); await wait(800);
    document.querySelector('#balFacs [data-fac="YARD D"]').click(); await wait(800);
    const emptyState = document.getElementById('balList').innerText.replace(/\\s+/g,' ');
    const btn = document.getElementById('goRcv');
    if (!btn) return { carried, emptyState, reached: false };
    btn.click(); await wait(900);
    return { carried, emptyState, reached: true,
             placeholder: !!document.querySelector('#rcvFac .placeholder'),
             facText: document.getElementById('rcvFac').innerText.replace(/\\s+/g,' '),
             submitDisabled: document.getElementById('rcvSubmit').disabled };
  })()`);
  ok('an action started at a warehouse carries it onto Receive (10.A)',
    /YARD A/.test(inherit.carried), inherit.carried);
  ok('an empty yard still offers its own "Receive stock" button',
    inherit.reached === true, inherit.emptyState.slice(0, 140));
  ok('that button does NOT inherit the previous warehouse (6.B)',
    inherit.placeholder === true && !/YARD A/.test(inherit.facText || ''),
    JSON.stringify(inherit));
  ok('and it cannot be submitted until a warehouse is chosen',
    inherit.submitDisabled === true, JSON.stringify(inherit));

  /* ---- 11. nothing threw while all of that was driven ---- */
  // The API is blocked in this run, so a failed fetch to script.google.com is
  // expected and is NOT a scripting error. Only real thrown exceptions and
  // console.error output count.
  const thrown = events
    .filter(e => e.method === 'Runtime.exceptionThrown')
    .map(e => e.params?.exceptionDetails?.exception?.description
      || e.params?.exceptionDetails?.text || 'exception');
  const consoleErrors = events
    .filter(e => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    .map(e => (e.params.args || []).map(a => a.value ?? a.description ?? '').join(' '))
    .filter(t => !/script\.google\.com|ERR_BLOCKED|Failed to fetch/i.test(t));
  ok('nothing threw while driving all of the above',
    thrown.length === 0, thrown.join('\n        '));
  ok('no console errors while driving all of the above',
    consoleErrors.length === 0, consoleErrors.join('\n        '));

} catch (err) {
  fail++;
  console.log(`\n  ERROR  ${err.message}`);
} finally {
  try { ws?.close(); } catch { /* gone */ }
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
