/**
 * Drive the Activity screen in a real Chrome, against a STUBBED server.
 *
 * Run:  node scripts/verify-activity.mjs [url]     (npm run verify:activity)
 *       Pair it with `npm run serve` and pass http://127.0.0.1:8787/.
 *
 * Why a stub and not the live server: the things worth testing here are
 * destructive. Cancelling an entry writes a reversing row into the real
 * Ledger, and the yard's book is the record of physical stock typed in by
 * hand — a test must never be able to move it. So `fetch` is replaced before
 * the app loads, every call to script.google.com is answered from a fixture,
 * and every POST is recorded for the assertions to read back.
 *
 * THE CHECKS THAT MATTER, in order of how much they would cost to get wrong:
 *
 *  1. A correction cancels the original ONLY when the replacement is saved.
 *     Opening the form and walking away must write nothing. Sending the void
 *     up front is the obvious implementation and it silently shrinks the yard
 *     by the original quantity every time someone changes their mind.
 *  2. A correction that the server REFUSES must not queue the replacement
 *     either — otherwise the refusal leaves a duplicate behind.
 *  3. An already-cancelled row, and a cancellation itself, offer no buttons.
 *  4. The Issue screen counts the stock the pending cancellation is about to
 *     hand back, or correcting an issue is refused for "not enough stock"
 *     whenever the yard is nearly empty.
 *
 * Every fixture quantity is a different number, so a check cannot pass by
 * accident against code that reads the wrong field.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_UNDER_TEST = (u => {
  const stripped = String(u).replace(/(?:index\.html)?(?:[?#].*)?$/, '');
  return stripped.endsWith('/') ? stripped : stripped + '/';
})(process.argv[2] || 'http://127.0.0.1:8787/');
const PORT = 9341;
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const profile = mkdtempSync(join(tmpdir(), 'oy-act-'));
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

/*
 * The fake server. Installed before any app code runs.
 *
 * YARD A / STEEL-10 holds 40 total, 5 damaged => 35 good. OY-ISSUE1 issued 30
 * from it. So correcting that issue upward to 50 is only possible if the 30
 * coming back is counted: 35 + 30 = 65 available, and 50 < 65. Against code
 * that forgets the allowance, 50 > 35 and the button stays disabled. The three
 * figures (35, 65, 50) are deliberately distinct.
 */
const STUB = `
window.__posts = [];
window.__gets = [];
window.__voidMode = 'ok';

/*
 * Dubai midnight, worked out HERE with a hardcoded +4 rather than by importing
 * lib/dates.js. That is deliberate: a test that borrows the implementation's
 * own idea of "today" agrees with it whether or not either is right. Dubai has
 * no DST, so +4 is exact, and this stays an independent second opinion.
 */
const DUBAI_OFFSET = 4 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
const NOW = Date.now();
const TODAY_START = Math.floor((NOW + DUBAI_OFFSET) / DAY) * DAY - DUBAI_OFFSET;
const iso = ms => new Date(ms).toISOString();
window.__todayStart = iso(TODAY_START);
window.__yestStart = iso(TODAY_START - DAY);

// The four rows the cancel/correct checks above rely on are all dated TODAY,
// so the default window shows them and those checks are unaffected. The three
// after them exist only to be filtered OUT.
const T_MORNING = TODAY_START + 9 * 3600 * 1000;      // 09:00 today, Dubai
window.__todayStampIso = iso(T_MORNING);
const LEDGER = [
  { txnId:'OY-VOID9', type:'VOID', facility:'YARD A', toFacility:'', sku:'CEM-50',
    qty:7, damagedQty:0, condition:'', refNo:'', vehicleNo:'', location:'',
    remarks:'Cancelled OY-GONE1', recordedBy:'Harish',
    clientTs:iso(T_MORNING + 180000), serverTs:iso(T_MORNING + 180000),
    voidOf:'OY-GONE1', voidOfType:'INBOUND' },
  { txnId:'OY-GONE1', type:'INBOUND', facility:'YARD A', toFacility:'', sku:'CEM-50',
    qty:7, damagedQty:0, condition:'', refNo:'GRN-7', vehicleNo:'', location:'',
    remarks:'', recordedBy:'Harish',
    clientTs:iso(T_MORNING + 120000), serverTs:iso(T_MORNING + 120000),
    voidOf:'', voidOfType:'' },
  { txnId:'OY-ISSUE1', type:'OUTBOUND', facility:'YARD A', toFacility:'', sku:'STEEL-10',
    qty:30, damagedQty:0, condition:'GOOD', refNo:'DO-55', vehicleNo:'DXB1234',
    location:'', remarks:'to site', recordedBy:'Harish',
    clientTs:iso(T_MORNING + 60000), serverTs:iso(T_MORNING + 60000),
    voidOf:'', voidOfType:'' },
  { txnId:'OY-RECV1', type:'INBOUND', facility:'YARD A', toFacility:'', sku:'STEEL-10',
    qty:70, damagedQty:5, condition:'', refNo:'GRN-1', vehicleNo:'', location:'',
    remarks:'', recordedBy:'Harish',
    clientTs:iso(T_MORNING), serverTs:iso(T_MORNING),
    voidOf:'', voidOfType:'' },
  // Recorded 23:00 LAST NIGHT, uploaded 08:00 THIS MORNING. It belongs to
  // yesterday, and filtering on arrival instead of on when it happened would
  // put it in today's list.
  { txnId:'OY-LATE', type:'INBOUND', facility:'YARD A', toFacility:'', sku:'STEEL-10',
    qty:12, damagedQty:0, condition:'', refNo:'GRN-LATE', vehicleNo:'', location:'',
    remarks:'night shift', recordedBy:'Harish',
    clientTs:iso(TODAY_START - 3600000), serverTs:iso(TODAY_START + 8 * 3600000),
    voidOf:'', voidOfType:'' },
  { txnId:'OY-WEEK', type:'INBOUND', facility:'YARD A', toFacility:'', sku:'STEEL-10',
    qty:13, damagedQty:0, condition:'', refNo:'GRN-WEEK', vehicleNo:'', location:'',
    remarks:'', recordedBy:'Harish',
    clientTs:iso(TODAY_START - 3 * DAY), serverTs:iso(TODAY_START - 3 * DAY),
    voidOf:'', voidOfType:'' },
  { txnId:'OY-ANCIENT', type:'INBOUND', facility:'YARD A', toFacility:'', sku:'STEEL-10',
    qty:14, damagedQty:0, condition:'', refNo:'GRN-OLD', vehicleNo:'', location:'',
    remarks:'', recordedBy:'Harish',
    clientTs:iso(TODAY_START - 40 * DAY), serverTs:iso(TODAY_START - 40 * DAY),
    voidOf:'', voidOfType:'' }
];
const META = { epoch:9, itemsEpoch:3, facilitiesEpoch:2, schemaVersion:2,
  serverTs:'2026-09-20T12:00:00.000Z' };
const jsonRes = obj => new Response(JSON.stringify(obj),
  { status:200, headers:{ 'Content-Type':'application/json' } });

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (!/script\\.google\\.com/.test(url)) return realFetch(input, init);
  const action = (url.match(/[?&]action=([^&]+)/) || [])[1] || '';
  if (init && init.method === 'POST') {
    let body = {};
    try { body = JSON.parse(init.body); } catch {}
    window.__posts.push({ action, body });
    if (action === 'voidTxn') {
      if (window.__voidMode === 'refuse') {
        return jsonRes({ ok:false, error:{ code:'WOULD_GO_NEGATIVE',
          message:'Cancelling this would leave STEEL-10 at YARD A on -5 total / 0 damaged.',
          retryable:false }, meta:META });
      }
      if (window.__voidMode === 'offline') {
        throw new TypeError('Failed to fetch');
      }
      return jsonRes({ ok:true, data:{ txnId:'OY-NEWVOID', status:'applied',
        voidOf: body.txnId,
        balances:[{ facility:'YARD A', sku:'STEEL-10', total:40, damaged:5, good:35,
          lastTxnTs:'2026-09-20T12:00:00.000Z' }] }, meta:META });
    }
    return jsonRes({ ok:true, data:{ results:[] }, meta:META });
  }
  if (action === 'getLedger') {
    const q = new URL(url, location.href).searchParams;
    const since = q.get('since') || '';
    const until = q.get('until') || '';
    window.__gets.push({ action, since, until });
    // Filtered on clientTs — when the movement happened — mirroring the server.
    const rows = LEDGER.filter(r => {
      const ms = Date.parse(r.clientTs);
      if (since && ms < Date.parse(since)) return false;
      if (until && ms >= Date.parse(until)) return false;
      return true;
    });
    return jsonRes({ ok:true, data:{ sku:'', facility:'', since, until, rows, more:false }, meta:META });
  }
  if (action === 'bootstrap') {
    return jsonRes({ ok:true, data:{
      users:['Harish'],
      items:[{ sku:'STEEL-10', description:'Steel Bar 10mm', uom:'PCS', active:true, rev:1 },
             { sku:'CEM-50', description:'Cement 50kg', uom:'BAG', active:true, rev:1 }],
      facilities:[{ facility:'YARD A', description:'Main yard', active:true, rev:1 },
                  { facility:'YARD B', description:'Second', active:true, rev:1 }],
      balances:[{ facility:'YARD A', sku:'STEEL-10', total:40, damaged:5, good:35, lastTxnTs:'x' },
                { facility:'YARD A', sku:'CEM-50', total:12, damaged:0, good:12, lastTxnTs:'x' }]
    }, meta:META });
  }
  return jsonRes({ ok:true, data:{}, meta:META });
};
localStorage.setItem('oy_user','Harish');
`;

const cleanup = () => {
  try { chrome.kill(); } catch { /* already gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
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
    } else if (m.method) {
      events.push(m);
    }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  S = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, S);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB }, S);

  console.log(`\nActivity screen tests against ${URL_UNDER_TEST}\n`);
  await send('Page.navigate', { url: URL_UNDER_TEST }, S);
  await sleep(6000);

  /* ---- 1. the tab exists and opens ---- */
  const tab = await run(`(() => {
    const t = document.querySelector('.tab[data-screen="activity"]');
    if (!t) return { there:false };
    t.click();
    return { there:true, label:t.textContent.trim() };
  })()`);
  ok('there is an Activity tab', tab.there === true);
  await sleep(1800);

  const screenOn = await run(
    `document.getElementById('scr-activity').classList.contains('active')`);
  ok('tapping it shows the Activity screen', screenOn === true);

  /* ---- 2. every movement is listed, newest first ---- */
  const rows = await run(`(() => {
    const rs = [...document.querySelectorAll('#actList .mv-row')];
    return rs.map(r => ({
      txn: r.dataset.txn || '',
      text: r.querySelector('.mv').textContent.replace(/\\s+/g,' ').trim(),
      cancelled: r.querySelector('.mv').classList.contains('is-cancelled'),
      cancel: !!r.querySelector('[data-cancel]'),
      correct: !!r.querySelector('[data-correct]')
    }));
  })()`);
  ok('every movement in the book is listed', rows.length === 4,
    `saw ${rows.length}: ${rows.map(r => r.txn).join(', ')}`);
  ok('they are newest first', rows[0]?.txn === 'OY-VOID9' && rows[3]?.txn === 'OY-RECV1',
    rows.map(r => r.txn).join(' -> '));
  ok('the list is not scoped to one item (two SKUs are on screen)',
    rows.some(r => /STEEL-10/.test(r.text)) && rows.some(r => /CEM-50/.test(r.text)));

  /* ---- 3. what can and cannot be acted on ---- */
  const gone = rows.find(r => r.txn === 'OY-GONE1');
  ok('an already-cancelled entry is struck through', gone?.cancelled === true);
  ok('an already-cancelled entry offers NO buttons',
    gone?.cancel === false && gone?.correct === false);
  ok('it still says CANCELLED rather than disappearing', /CANCELLED/.test(gone?.text || ''));

  const voidRow = rows.find(r => r.txn === 'OY-VOID9');
  ok('a cancellation itself cannot be cancelled',
    voidRow?.cancel === false && voidRow?.correct === false);

  const recv = rows.find(r => r.txn === 'OY-RECV1');
  const iss = rows.find(r => r.txn === 'OY-ISSUE1');
  ok('a live receipt offers both Cancel and Correct',
    recv?.cancel === true && recv?.correct === true);
  ok('a live issue offers both Cancel and Correct',
    iss?.cancel === true && iss?.correct === true);

  /* ---- 4. cancelling asks first, then posts exactly one voidTxn ---- */
  await run(`window.__posts.length = 0`);
  await run(`document.querySelector('[data-cancel="OY-RECV1"]').click()`);
  await sleep(600);
  const confirmUp = await run(`(() => {
    const b = document.getElementById('sheetBackdrop');
    return { open: !!b && getComputedStyle(b).display !== 'none',
             text: (document.getElementById('sheetBody')||{}).textContent || '' };
  })()`);
  ok('Cancel asks for confirmation first', confirmUp.open === true);
  ok('the confirmation says the entry is kept, not deleted',
    /Nothing is deleted/i.test(confirmUp.text), confirmUp.text.slice(0, 120));

  const postedBeforeYes = await run(`window.__posts.length`);
  ok('nothing is sent while the question is still on screen', postedBeforeYes === 0);

  await run(`document.getElementById('cfYes').click()`);
  await sleep(1500);
  const voidPosts = await run(
    `window.__posts.filter(p => p.action === 'voidTxn').map(p => p.body)`);
  ok('confirming sends exactly one cancellation', voidPosts.length === 1,
    `sent ${voidPosts.length}`);
  ok('it names the right entry', voidPosts[0]?.txnId === 'OY-RECV1');
  ok('it carries who did it', voidPosts[0]?.recordedBy === 'Harish');
  ok('it carries an idempotency key', !!voidPosts[0]?.idemKey);

  /* ---- 5. Correct prefills the form and writes NOTHING yet ---- */
  await run(`window.__posts.length = 0`);
  await run(`document.querySelector('.tab[data-screen="activity"]').click()`);
  await sleep(1500);
  await run(`document.querySelector('[data-correct="OY-ISSUE1"]').click()`);
  await sleep(900);
  await run(`document.getElementById('cfYes').click()`);
  await sleep(1800);

  const form = await run(`(() => ({
    screen: document.getElementById('scr-issue').classList.contains('active'),
    qty: (document.getElementById('issQty')||{}).value,
    ref: (document.getElementById('issRef')||{}).value,
    veh: (document.getElementById('issVehicle')||{}).value,
    note: (document.getElementById('issNote')||{}).value,
    banner: !document.getElementById('issCorrecting').hidden,
    bannerText: document.getElementById('issCorrecting').textContent,
    avail: (document.querySelector('#issAvail .v')||{}).textContent
  }))()`);
  ok('Correct opens the Issue screen', form.screen === true);
  ok('the quantity is prefilled from the original', form.qty === '30', `saw "${form.qty}"`);
  ok('the reference is prefilled', form.ref === 'DO-55', `saw "${form.ref}"`);
  ok('the vehicle is prefilled', form.veh === 'DXB1234', `saw "${form.veh}"`);
  ok('the remarks are prefilled', form.note === 'to site', `saw "${form.note}"`);
  ok('a banner says which entry is being corrected',
    form.banner === true && /OY-ISSUE1/.test(form.bannerText));
  ok('the banner says nothing has changed yet', /nothing has changed yet/i.test(form.bannerText));

  const postedOnOpen = await run(`window.__posts.length`);
  ok('OPENING a correction sends nothing at all', postedOnOpen === 0,
    `sent ${postedOnOpen}`);

  /* ---- 6. the stock the cancellation will hand back is counted ---- */
  ok('available counts the 30 coming back (35 good + 30 = 65)',
    String(form.avail).replace(/[^0-9]/g, '') === '65', `saw "${form.avail}"`);

  const canRaise = await run(`(async () => {
    const q = document.getElementById('issQty');
    q.value = '50';
    q.dispatchEvent(new Event('input', { bubbles:true }));
    await new Promise(r => setTimeout(r, 700));
    return { disabled: document.getElementById('issSubmit').disabled,
             err: (document.getElementById('issQtyErr')||{}).textContent || '' };
  })()`);
  ok('raising the issue to 50 is allowed, because 30 is coming back',
    canRaise.disabled === false, `disabled=${canRaise.disabled} err="${canRaise.err}"`);

  const tooMuch = await run(`(async () => {
    const q = document.getElementById('issQty');
    q.value = '66';
    q.dispatchEvent(new Event('input', { bubbles:true }));
    await new Promise(r => setTimeout(r, 700));
    return document.getElementById('issSubmit').disabled;
  })()`);
  ok('but 66 is still refused — the allowance is not a blank cheque', tooMuch === true);

  /* ---- 7. walking away from a correction writes nothing ---- */
  await run(`document.querySelector('.tab[data-screen="balance"]').click()`);
  await sleep(1200);
  const afterLeaving = await run(`(() => ({
    posts: window.__posts.length,
    banner: !document.getElementById('issCorrecting').hidden
  }))()`);
  ok('switching tabs abandons the correction without sending anything',
    afterLeaving.posts === 0, `sent ${afterLeaving.posts}`);
  ok('and the banner is cleared', afterLeaving.banner === false);

  // The dangerous half of abandoning. Leaving the form sends nothing either
  // way — the bug is a correction that OUTLIVES the form and attaches itself
  // to the next unrelated entry, cancelling a transaction nobody asked about.
  // Checking only "no post on leaving" passes happily against that bug.
  await run(`window.__posts.length = 0`);
  await run(`document.querySelector('.tab[data-screen="issue"]').click()`);
  await sleep(1500);
  const plainIssue = await run(`(async () => {
    const setSel = async (id, value) => {
      const el = document.getElementById(id);
      el.click();
      await new Promise(r => setTimeout(r, 500));
      // The warehouse picker marks rows data-fac; the item picker data-pick.
      const hit = [...document.querySelectorAll('#sheetBody [data-fac], #sheetBody [data-pick]')]
        .find(n => (n.dataset.fac === value || n.dataset.pick === value));
      if (hit) hit.click();
      await new Promise(r => setTimeout(r, 700));
    };
    await setSel('issFac', 'YARD A');
    await setSel('issItem', 'STEEL-10');
    const q = document.getElementById('issQty');
    q.value = '3';
    q.dispatchEvent(new Event('input', { bubbles:true }));
    await new Promise(r => setTimeout(r, 700));
    const disabled = document.getElementById('issSubmit').disabled;
    if (!disabled) document.getElementById('issSubmit').click();
    await new Promise(r => setTimeout(r, 2000));
    return { disabled, actions: window.__posts.map(p => p.action) };
  })()`);
  ok('a normal entry recorded afterwards is actually submittable',
    plainIssue.disabled === false, 'the rest of this check is vacuous otherwise');
  ok('an abandoned correction does NOT cancel anything on the next save',
    !plainIssue.actions.includes('voidTxn'),
    `sent: ${plainIssue.actions.join(', ') || 'nothing'}`);

  /* ---- 8. saving a correction cancels the original FIRST ---- */
  await run(`window.__posts.length = 0`);
  await run(`document.querySelector('.tab[data-screen="activity"]').click()`);
  await sleep(1500);
  await run(`document.querySelector('[data-correct="OY-ISSUE1"]').click()`);
  await sleep(900);
  await run(`document.getElementById('cfYes').click()`);
  await sleep(1800);
  await run(`(async () => {
    const q = document.getElementById('issQty');
    q.value = '25';
    q.dispatchEvent(new Event('input', { bubbles:true }));
    await new Promise(r => setTimeout(r, 700));
    document.getElementById('issSubmit').click();
    await new Promise(r => setTimeout(r, 2000));
  })()`);
  const order = await run(`window.__posts.map(p => p.action)`);
  ok('saving sends the cancellation', order.includes('voidTxn'));
  ok('the cancellation goes BEFORE the replacement is uploaded',
    order.indexOf('voidTxn') === 0, order.join(' -> '));
  const queued = await run(`(async () => {
    const m = await import('${URL_UNDER_TEST}lib/outbox.js');
    const items = await m.pendingItems();
    return items.map(i => ({ type:i.type, sku:i.sku, qty:i.payload && i.payload.qty }));
  })()`);
  ok('the corrected entry is queued with the NEW quantity',
    queued.some(q => q.type === 'OUTBOUND' && q.qty === 25),
    JSON.stringify(queued));

  /* ---- 9. a REFUSED cancellation must not queue a replacement ---- */
  await run(`window.__voidMode = 'refuse'; window.__posts.length = 0`);
  const queuedBefore = await run(`(async () => {
    const m = await import('${URL_UNDER_TEST}lib/outbox.js');
    return (await m.pendingItems()).length;
  })()`);
  await run(`document.querySelector('.tab[data-screen="activity"]').click()`);
  await sleep(1500);
  await run(`document.querySelector('[data-correct="OY-RECV1"]').click()`);
  await sleep(900);
  await run(`document.getElementById('cfYes').click()`);
  await sleep(1800);
  const refused = await run(`(async () => {
    const q = document.getElementById('rcvQty');
    q.value = '80';
    q.dispatchEvent(new Event('input', { bubbles:true }));
    await new Promise(r => setTimeout(r, 700));
    document.getElementById('rcvSubmit').click();
    await new Promise(r => setTimeout(r, 2000));
    const m = await import('${URL_UNDER_TEST}lib/outbox.js');
    return {
      queued: (await m.pendingItems()).length,
      toast: (document.getElementById('toast')||{}).textContent || '',
      stillOnForm: document.getElementById('scr-receive').classList.contains('active'),
      submitUsable: document.getElementById('rcvSubmit').disabled === false
    };
  })()`);
  ok('a refused cancellation queues NO replacement',
    refused.queued === queuedBefore,
    `before ${queuedBefore}, after ${refused.queued}`);
  ok('and it says why, in plain English',
    /already moved|would leave|negative/i.test(refused.toast), `toast: "${refused.toast}"`);
  ok('the user is left on the form, able to try again',
    refused.stillOnForm === true && refused.submitUsable === true);

  /* ---- 10. no connection is survivable ---- */
  await run(`window.__voidMode = 'offline'`);
  await run(`document.querySelector('.tab[data-screen="balance"]').click()`);
  await sleep(800);
  await run(`document.querySelector('.tab[data-screen="activity"]').click()`);
  await sleep(1500);
  await run(`document.querySelector('[data-cancel="OY-ISSUE1"]').click()`);
  await sleep(600);
  await run(`document.getElementById('cfYes').click()`);
  await sleep(2000);
  const offlineToast = await run(`(document.getElementById('toast')||{}).textContent || ''`);
  ok('with no connection, cancelling says so instead of failing silently',
    /connection/i.test(offlineToast), `toast: "${offlineToast}"`);

  /* ---- 11. the date window ---- */
  await run(`window.__voidMode = 'ok'`);
  await run(`document.querySelector('.tab[data-screen="balance"]').click()`);
  await sleep(800);
  await run(`window.__gets.length = 0`);
  await run(`document.querySelector('.tab[data-screen="activity"]').click()`);
  await sleep(1800);

  const dflt = await run(`(() => {
    const chips = [...document.querySelectorAll('#actRanges [data-range]')];
    return {
      labels: chips.map(c => c.textContent.trim()),
      pressed: chips.filter(c => c.getAttribute('aria-pressed') === 'true')
        .map(c => c.dataset.range),
      sent: window.__gets[window.__gets.length - 1] || null,
      todayStart: window.__todayStart,
      txns: [...document.querySelectorAll('#actList .mv-row')].map(r => r.dataset.txn || ''),
      count: document.getElementById('actCount').textContent
    };
  })()`);

  ok('the window chips are the five asked for, in order',
    dflt.labels.join('|') === 'Today|Yesterday|Last 7 days|Last 30 days|All time',
    dflt.labels.join('|'));
  ok('the tab opens on Today', dflt.pressed.join(',') === 'today', dflt.pressed.join(','));
  ok('and only ONE chip is ever pressed', dflt.pressed.length === 1);
  ok('opening it asks the server only for today',
    dflt.sent && dflt.sent.since === dflt.todayStart && dflt.sent.until === '',
    JSON.stringify(dflt.sent) + ' vs since=' + dflt.todayStart);
  ok('the count line names the window so a short list cannot be mistaken for an empty yard',
    /Today/.test(dflt.count), dflt.count);

  // The one that matters: OY-LATE arrived this morning but happened last night.
  ok('an entry uploaded today but recorded last night is NOT in Today',
    !dflt.txns.includes('OY-LATE'), dflt.txns.join(','));
  ok('older movements are filtered out too',
    !dflt.txns.includes('OY-WEEK') && !dflt.txns.includes('OY-ANCIENT'),
    dflt.txns.join(','));
  ok("today's own movements are all still there",
    ['OY-VOID9', 'OY-GONE1', 'OY-ISSUE1', 'OY-RECV1'].every(t => dflt.txns.includes(t)),
    dflt.txns.join(','));

  const pick = async key => {
    await run(`document.querySelector('#actRanges [data-range="${key}"]').click()`);
    await sleep(1600);
    return run(`(() => ({
      sent: window.__gets[window.__gets.length - 1] || null,
      txns: [...document.querySelectorAll('#actList .mv-row')].map(r => r.dataset.txn || ''),
      pressed: [...document.querySelectorAll('#actRanges [data-range]')]
        .filter(c => c.getAttribute('aria-pressed') === 'true').map(c => c.dataset.range),
      count: document.getElementById('actCount').textContent
    }))()`);
  };

  const yest = await pick('yesterday');
  ok('Yesterday sends BOTH bounds, so it cannot also mean today',
    yest.sent && yest.sent.since && yest.sent.until,
    JSON.stringify(yest.sent));
  ok('Yesterday is exactly one day wide',
    yest.sent && Date.parse(yest.sent.until) - Date.parse(yest.sent.since) === 86400000,
    JSON.stringify(yest.sent));
  ok('and it DOES show the entry that was recorded last night',
    yest.txns.includes('OY-LATE'), yest.txns.join(','));
  ok("...while today's entries drop out of it",
    !yest.txns.includes('OY-RECV1'), yest.txns.join(','));
  ok('the pressed chip follows the choice', yest.pressed.join(',') === 'yesterday');

  const week = await pick('week');
  ok('Last 7 days reaches back past yesterday',
    week.txns.includes('OY-WEEK') && week.txns.includes('OY-RECV1'), week.txns.join(','));
  ok('but still not 40 days', !week.txns.includes('OY-ANCIENT'), week.txns.join(','));

  const all = await pick('all');
  ok('All time sends no bounds at all',
    all.sent && !all.sent.since && !all.sent.until, JSON.stringify(all.sent));
  const allServer = all.txns.filter(Boolean);
  ok('and shows everything, including the oldest row',
    allServer.includes('OY-ANCIENT') && allServer.length === 7,
    `server rows: ${allServer.join(',')}`);

  // Re-entering from the tab bar must start again at Today. A filter left on
  // "Yesterday" from a previous visit reads as an empty yard.
  await run(`document.querySelector('.tab[data-screen="balance"]').click()`);
  await sleep(800);
  await run(`document.querySelector('.tab[data-screen="activity"]').click()`);
  await sleep(1600);
  const reopened = await run(`[...document.querySelectorAll('#actRanges [data-range]')]
    .filter(c => c.getAttribute('aria-pressed') === 'true').map(c => c.dataset.range).join(',')`);
  ok('leaving and returning resets the window to Today', reopened === 'today', reopened);

  /* ---- 12. timestamps read DD-MM-YYYY HH:MM:SS in Dubai time ---- */
  const stamp = await run(`(() => {
    const row = document.querySelector('#actList .mv-row[data-txn="OY-RECV1"]');
    const text = row ? row.querySelector('.when').textContent : '';
    // the pattern match happens in Node, on the raw text -- see below
    // Independent expectation: format the same instant with Intl, pinned to
    // Dubai, rather than asking the app what it thinks the answer is.
    const d = new Date(window.__todayStampIso);
    const p = {};
    for (const part of new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Dubai',
        year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' })
        .formatToParts(d)) if (part.type !== 'literal') p[part.type] = part.value;
    return {
      want: p.day + '-' + p.month + '-' + p.year + ' ' + p.hour + ':' + p.minute + ':' + p.second,
      raw: text,
      utcHour: String(d.getUTCHours()).padStart(2, '0')
    };
  })()`);
  const STAMP_RE = /\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}/;
  stamp.shown = (String(stamp.raw).match(STAMP_RE) || [''])[0];
  ok('a timestamp is shown as DD-MM-YYYY HH:MM:SS', !!stamp.shown, stamp.raw);
  ok('and it is the Dubai time, to the second', stamp.shown === stamp.want,
    `shown ${stamp.shown}, expected ${stamp.want}`);
  // `stamp.shown &&` is load-bearing. Without it an empty `shown` — which is
  // exactly what a broken extraction produces — compares unequal to the UTC
  // hour and this passes while testing nothing. It did, for two runs.
  ok('it is NOT the UTC hour — the four-hour shift is really applied',
    !!stamp.shown && stamp.shown.slice(11, 13) !== stamp.utcHour,
    `shown hour "${stamp.shown.slice(11, 13)}", UTC hour ${stamp.utcHour}`);
  ok('the old relative wording is gone', !/Today |Yest /.test(stamp.raw), stamp.raw);

  /* ---- 13. nothing threw the whole way through ---- */
  const thrown = events.filter(e => e.method === 'Runtime.exceptionThrown');
  ok('nothing threw while driving all of the above', thrown.length === 0,
    thrown.map(e => e.params?.exceptionDetails?.exception?.description || '?').join(' | '));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
} catch (err) {
  console.error('\nverify-activity could not run:', err.message, '\n');
  cleanup();
  process.exit(1);
}
