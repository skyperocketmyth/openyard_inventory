/**
 * Run the real gas/ files against a FAKE SpreadsheetApp, offline.
 *
 *   node scripts/gas-harness.cjs > after.txt
 *
 * Why this exists: the Apps Script backend can otherwise only be tested by
 * deploying it and hitting the live Sheet, which is slow, pollutes real data,
 * and is subject to Google returning HTML error pages at HTTP 200. This loads
 * each gas/ file into a FRESH vm context per action — which is exactly what a
 * fresh HTTP request is, so the per-request memos in Code.js start empty just
 * as they do in production — and logs every Sheet API call it makes.
 *
 * HOW TO USE IT ON A REFACTOR (this is the point):
 *   git stash                      # or check out the pre-change code
 *   node scripts/gas-harness.cjs > baseline.txt
 *   git stash pop
 *   node scripts/gas-harness.cjs > after.txt
 *   diff baseline.txt after.txt    # behaviour must be identical; only the
 *                                  # "calls:" lines should change
 *
 * It covers 45 action paths including setup on an empty book, a missing Meta
 * tab, rebuildSnapshot, purgeTestData, voidTxn, duplicate-idem replay,
 * read_only, and an all-rejected batch — plus, since S02, the facilities tab,
 * transfers, the opening-balance guard, the multi-key void, the three
 * opening_done rebuild cases and the schema gate.
 *
 * THE ORDER OF THE run() LINES IS PART OF THE TOOL. A pre-existing scenario
 * keeps its label, its position and its expression forever, so the diff stays
 * readable. New scenarios go at the END of the file, never in the middle.
 *
 * It is a DIFF TOOL, not a pass/fail suite — it prints state and call counts
 * for a human (or an agent) to compare. `npm test` remains the assertion suite.
 *
 * .cjs, not .mjs: package.json sets "type": "module" and this uses require().
 *
 * NOTE for the facilities work: a fake Sheet cannot prove Apps Script's real
 * flush ordering, nor that a memoised Sheet object still behaves after
 * insertSheet in the same request. Those need scripts/smoke.mjs against a
 * deployment. This catches everything else, including every column-index
 * mistake, which is the main risk when H_LEDGER changes shape.
 */

// Every OTHER action path, each in a fresh vm context (= a fresh HTTP request),
// so the per-request memos start empty exactly as they would in production.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const G = process.env.GASDIR || path.join(__dirname, '..', 'gas') + path.sep;

function makeSheet(name, grid, calls){
  const log=(o,d)=>calls.push(o+(d?(' '+d):''));
  const s = {
    _g: grid,
    getName(){ return name; },
    getLastRow(){ log('getLastRow',name); return s._g.length; },
    getLastColumn(){ log('getLastColumn',name); return s._g.reduce((m,r)=>Math.max(m,r.length),0); },
    getMaxRows(){ return Math.max(s._g.length,100); },
    getRange(r,c,nr,nc){
      nr = nr===undefined?1:nr; nc = nc===undefined?1:nc;
      return {
        getValues(){ log('getValues',name+' r'+r+' n'+nr+'x'+nc);
          const out=[]; for(let i=0;i<nr;i++){ const row=s._g[r-1+i]||[]; const o=[];
            for(let j=0;j<nc;j++) o.push(row[c-1+j]===undefined?'':row[c-1+j]); out.push(o);} return out; },
        getValue(){ return this.getValues()[0][0]; },
        setValues(v){ log('setValues',name+' r'+r+' n'+nr+'x'+nc);
          for(let i=0;i<v.length;i++){ const tr=r-1+i; while(s._g.length<=tr) s._g.push([]);
            for(let j=0;j<v[i].length;j++) s._g[tr][c-1+j]=v[i][j]; } return this; },
        setValue(x){ log('setValue',name+' r'+r+'c'+c);
          while(s._g.length<r) s._g.push([]); s._g[r-1][c-1]=x; return this; },
        setNumberFormat(){ return this; }, setFontWeight(){ return this; },
        setBackground(){ return this; }, setFontColor(){ return this; },
        clearContent(){ log('clearContent',name);
          for(let i=0;i<nr;i++){ const tr=r-1+i; if(!s._g[tr])continue;
            for(let j=0;j<nc;j++) s._g[tr][c-1+j]=''; } return this; }
      };
    },
    appendRow(row){ log('appendRow',name); s._g.push(row.slice()); },
    setFrozenRows(){}, deleteRow(i){ s._g.splice(i-1,1); }
  };
  return s;
}

function fullBook(){
  return {
    Items:[['sku','description','uom','barcode','active','cb','ct','ub','ut','item_rev'],
           ['WIDGET-A','Widget A','PCS','',true,'x','t','x','t',1],
           ['WIDGET-B','Widget B','PCS','',true,'x','t','x','t',1]],
    // 20 columns since S02. The two rows keep their ids, quantities and
    // timestamps exactly as they were — only the new facility/vehicle columns
    // are added — so the diff against the pre-change baseline stays readable.
    Ledger:[['txn_id','idem_key','txn_type','facility','to_facility','sku','qty','damaged_qty','condition','ref_no','vehicle_no','location','remarks','recorded_by','client_ts','server_ts','device_id','app_version','void_of_txn_id','void_of_type'],
            ['OY-ORIG1','idemorig1','INBOUND','YARD A','','WIDGET-A',40,3,'GOOD','R1','','L1','','Harish','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','d','1.0.0','',''],
            ['OY-ORIG2','idemorig2','DAMAGE','YARD A','','WIDGET-B',5,0,'','','','','','Harish','2026-09-02T00:00:00.000Z','2026-09-02T00:00:00.000Z','d','1.0.0','','']],
    Users:[['name','active','added_ts'],['Harish',true,'t'],['Old Hand',false,'t']],
    // schema_version is 2 since S02: the Ledger is 20 columns wide and the
    // snapshot 8, and gas/ refuses to write to a book that still says 1.
    // facilities_epoch is APPENDED after read_only so the `read_only blocks a
    // write` scenario can keep addressing Meta[4].
    Meta:[['key','value'],['schema_version',2],['ledger_epoch',7],['items_epoch',3],['read_only','FALSE'],['facilities_epoch',1]],
    Balance_Snapshot:[['facility','sku','total_qty','damaged_qty','good_qty','opening_done','last_txn_ts','updated_ts'],
                      ['YARD A','WIDGET-A',40,3,37,false,'2026-09-01T00:00:00.000Z','t'],
                      ['YARD A','WIDGET-B',50,5,45,false,'2026-09-02T00:00:00.000Z','t']],
    Facilities:[['facility','description','active','created_by','created_ts','facility_rev'],
                ['YARD A','Main yard',true,'Harish','t',1],
                ['YARD B','Overflow yard',true,'Harish','t',1],
                ['YARD C','Closed yard',false,'Harish','t',1]],
    Rejections:[['server_ts','idem_key','recorded_by','device_id','payload_json','error_code','error_message']]
  };
}

// `extraTabs` echoes further tabs for THIS scenario only. Adding a tab to the
// standard echo list below would put a new line under every scenario in the
// file and bury the real differences.
function run(label, book, expr, extraTabs){
  const calls=[]; const sheets={};
  for(const k in book) sheets[k]=makeSheet(k,book[k],calls);
  const ctx = {
    SpreadsheetApp:{ openById(){ calls.push('openById'); return {
        getSheetByName(n){ return sheets[n]||null; },
        getSheets(){ return Object.keys(sheets).map(k=>sheets[k]); },
        getName(){ return 'fake'; },
        insertSheet(n){ calls.push('insertSheet '+n); book[n]=[]; sheets[n]=makeSheet(n,book[n],calls); return sheets[n]; },
        deleteSheet(n){ calls.push('deleteSheet'); } }; } },
    LockService:{ getScriptLock(){ return { tryLock(){return true;}, releaseLock(){} }; } },
    CacheService:{ getScriptCache(){ return { get(){return null;}, getAll(){return {};}, put(){}, putAll(){} }; } },
    ContentService:{ MimeType:{JSON:'json'}, createTextOutput(s){ return { setMimeType(){ return {_body:s}; } }; } },
    Logger:{ log(){} }, console
  };
  vm.createContext(ctx);
  for(const f of ['Code.js','Balance.js','Ledger.js','Setup.js'])
    vm.runInContext(fs.readFileSync(G+f,'utf8'), ctx, {filename:f});
  let out;
  try { out = vm.runInContext(expr, ctx); } catch(e){ out = {THREW:String(e.message||e)}; }
  const shown = (out && out._body) ? JSON.parse(out._body) : out;
  console.log('### '+label+'  ['+calls.length+' calls, '
    + calls.filter(c=>/^(openById|getValues|setValues|setValue |appendRow)/.test(c)).length + ' round trips]');
  console.log(JSON.stringify(shown, null, 1));
  console.log('   tabs after: ' + JSON.stringify(Object.keys(book).map(k=>k+':'+book[k].length)));
  // 6 wide, not 4: Balance_Snapshot's opening_done is column 6 and it has to
  // be visible in the diff — a rebuild that blanks it is otherwise invisible.
  for(const k of ['Meta','Users','Balance_Snapshot'])
    if(book[k]) console.log('   '+k+' = '+JSON.stringify(book[k].map(r=>r.slice(0,6))));
  for(const k of (extraTabs||[]))
    if(book[k]) console.log('   '+k+' = '+JSON.stringify(book[k]));
  console.log('   calls: '+JSON.stringify(calls));
  console.log('');
}

run('ping (envelope only)', fullBook(), "doGet({parameter:{action:'ping'}})");
run('bootstrap', fullBook(), "doGet({parameter:{action:'bootstrap'}})");
run('getBalances no epoch', fullBook(), "doGet({parameter:{action:'getBalances'}})");
run('getBalances matching epoch', fullBook(), "doGet({parameter:{action:'getBalances',sinceEpoch:'7'}})");
run('getUsers', fullBook(), "doGet({parameter:{action:'getUsers'}})");
run('getItems', fullBook(), "doGet({parameter:{action:'getItems'}})");
run('getLedger', fullBook(), "doGet({parameter:{action:'getLedger',sku:'WIDGET-A'}})");
run('diag', fullBook(), "doGet({parameter:{action:'diag'}})");
run('addUser new', fullBook(), "addUser_({name:'Nadia'})");
run('addUser duplicate', fullBook(), "addUser_({name:'harish'})");
run('setUserActive false', fullBook(), "setUserActive_({name:'Harish',active:false})");
run('setUserActive reactivate', fullBook(), "setUserActive_({name:'Old Hand',active:true})");
run('upsertItem update', fullBook(), "upsertItem_({sku:'WIDGET-A',description:'Widget A v2',uom:'PCS',recordedBy:'Harish'})");
run('upsertItem create', fullBook(), "upsertItem_({sku:'WIDGET-Z',description:'Widget Z',uom:'KG',recordedBy:'Harish'})");
run('voidTxn of inbound', fullBook(), "voidTxn_({txnId:'OY-ORIG1',idemKey:'voidkey123',recordedBy:'Harish',reason:'keyed twice'})");
run('voidTxn already-voided guard', fullBook(), "voidTxn_({txnId:'OY-NOPE',idemKey:'voidkey124',recordedBy:'Harish'})");
run('rebuildSnapshot', fullBook(), "rebuildSnapshot_()");
run('purgeTestData', fullBook(), "purgeTestData_()");
run('setup on a populated book', fullBook(), "ensureTabs_()");
run('setup on an EMPTY book', {}, "ensureTabs_()");
run('read_only blocks a write', (()=>{const b=fullBook(); b.Meta[4]=['read_only','TRUE']; return b;})(),
    "submitTxnBatch_({txns:[{idemKey:'zzzzzzzz01',type:'INBOUND',facility:'YARD A',sku:'WIDGET-A',qty:1,recordedBy:'Harish'}]})");
run('duplicate idem key replays', fullBook(),
    "submitTxnBatch_({txns:[{idemKey:'idemorig1',type:'INBOUND',facility:'YARD A',sku:'WIDGET-A',qty:40,damagedQty:3,recordedBy:'Harish'}]})");
run('all-rejected batch still replies balances', fullBook(),
    "submitTxnBatch_({txns:[{idemKey:'yyyyyyyy01',type:'OUTBOUND',facility:'YARD A',sku:'WIDGET-A',qty:9999,recordedBy:'Harish'}]})");
run('missing Meta tab -> needsSetup', (()=>{const b=fullBook(); delete b.Meta; return b;})(),
    "doGet({parameter:{action:'ping'}})");

/* =================================================================== *
 * S02 — appended below this line. Everything above keeps its original
 * label, position and expression so the diff against the pre-change
 * baseline shows only the new columns and the new scenarios.
 * =================================================================== */

/** fullBook plus a committed TRANSFER of 10 WIDGET-A from YARD A to YARD B. */
function transferBook(){
  const b = fullBook();
  b.Ledger.push(['OY-TRF1','idemtrf1','TRANSFER','YARD A','YARD B','WIDGET-A',10,0,'GOOD','','','','','Harish','2026-09-03T00:00:00.000Z','2026-09-03T00:00:00.000Z','d','1.0.0','','']);
  b.Balance_Snapshot[1] = ['YARD A','WIDGET-A',30,3,27,false,'2026-09-03T00:00:00.000Z','t'];
  b.Balance_Snapshot.push(['YARD B','WIDGET-A',10,0,10,false,'2026-09-03T00:00:00.000Z','t']);
  return b;
}

/** fullBook with the opening balance already recorded for YARD A / WIDGET-A. */
function openedBook(){
  const b = fullBook();
  b.Balance_Snapshot[1] = ['YARD A','WIDGET-A',40,3,37,true,'2026-09-01T00:00:00.000Z','t'];
  return b;
}

run('getFacilities', fullBook(), "doGet({parameter:{action:'getFacilities'}})");
run('upsertFacility create', fullBook(),
    "upsertFacility_({facility:'YARD D',description:'New yard',recordedBy:'Harish'})", ['Facilities']);
run('upsertFacility near-duplicate rejected', fullBook(),
    "upsertFacility_({facility:'yard-a',description:'Should not be created',recordedBy:'Harish'})", ['Facilities']);
run('upsertFacility rename attempt leaves the key alone', fullBook(),
    "upsertFacility_({facility:'YARD A',description:'Main yard, north gate',recordedBy:'Harish'})", ['Facilities']);
run('upsertFacility rejects a pipe in the name', fullBook(),
    "upsertFacility_({facility:'YARD A | NORTH',description:'',recordedBy:'Harish'})", ['Facilities']);
run('transfer A to B', fullBook(),
    "submitTxnBatch_({txns:[{idemKey:'trf0000001',type:'TRANSFER',facility:'YARD A',toFacility:'YARD B',sku:'WIDGET-A',qty:10,recordedBy:'Harish'}]})",
    ['Ledger']);
run('transfer then issue at the destination in ONE batch', fullBook(),
    "submitTxnBatch_({txns:[{idemKey:'trf0000002',type:'TRANSFER',facility:'YARD A',toFacility:'YARD B',sku:'WIDGET-A',qty:10,recordedBy:'Harish'},{idemKey:'trf0000003',type:'OUTBOUND',facility:'YARD B',sku:'WIDGET-A',qty:10,recordedBy:'Harish'}]})");
run('transfer with too little at the source', fullBook(),
    "submitTxnBatch_({txns:[{idemKey:'trf0000004',type:'TRANSFER',facility:'YARD A',toFacility:'YARD B',sku:'WIDGET-A',qty:9999,recordedBy:'Harish'}]})");
run('voidTxn of a transfer', transferBook(),
    "voidTxn_({txnId:'OY-TRF1',idemKey:'voidtrf1234',recordedBy:'Harish',reason:'wrong yard'})",
    ['Ledger']);
run('second OPENING at the same facility is refused', openedBook(),
    "submitTxnBatch_({txns:[{idemKey:'opn0000001',type:'OPENING',facility:'YARD A',sku:'WIDGET-A',qty:100,recordedBy:'Harish'}]})");
run('OPENING at a second facility for the same SKU is allowed', openedBook(),
    "submitTxnBatch_({txns:[{idemKey:'opn0000002',type:'OPENING',facility:'YARD B',sku:'WIDGET-A',qty:100,recordedBy:'Harish'}]})");
run('two OPENINGs for the same key in ONE batch — the second is refused', fullBook(),
    "submitTxnBatch_({txns:[{idemKey:'opn0000003',type:'OPENING',facility:'YARD B',sku:'WIDGET-B',qty:100,recordedBy:'Harish'},{idemKey:'opn0000004',type:'OPENING',facility:'YARD B',sku:'WIDGET-B',qty:5,recordedBy:'Harish'}]})");
run('entry with no facility is refused', fullBook(),
    "submitTxnBatch_({txns:[{idemKey:'nofac00001',type:'INBOUND',sku:'WIDGET-A',qty:1,recordedBy:'Harish'}]})");
run('entry to an inactive facility is accepted and flagged in remarks', fullBook(),
    "submitTxnBatch_({txns:[{idemKey:'inact00001',type:'INBOUND',facility:'YARD C',sku:'WIDGET-A',qty:5,damagedQty:0,remarks:'from the gate',recordedBy:'Harish'}]})",
    ['Ledger']);
run('duplicate idem replay of a transfer returns BOTH balances', transferBook(),
    "submitTxnBatch_({txns:[{idemKey:'idemtrf1',type:'TRANSFER',facility:'YARD A',toFacility:'YARD B',sku:'WIDGET-A',qty:10,recordedBy:'Harish'}]})");
// A rebuild does not PRESERVE opening_done — it holds no prior snapshot to
// preserve anything from. It DERIVES the flag by re-reading the ledger, and
// the half that can actually go wrong is the VOID: a rule of "any key with an
// OPENING row is done" passes the first scenario below and is wrong for the
// other two. All three are here for that reason.
run('rebuildSnapshot DERIVES opening_done from the ledger', (()=>{const b=fullBook();
      b.Ledger.push(['OY-OPEN1','idemopen1','OPENING','YARD A','','WIDGET-C',100,0,'GOOD','','','','','Harish','2026-09-04T00:00:00.000Z','2026-09-04T00:00:00.000Z','d','1.0.0','','']);
      return b;})(),
    "rebuildSnapshot_()");
run('rebuildSnapshot: an OPENING that was later VOIDED rebuilds to opening_done FALSE', (()=>{const b=fullBook();
      b.Ledger.push(['OY-OPEN1','idemopen1','OPENING','YARD A','','WIDGET-C',100,0,'GOOD','','','','','Harish','2026-09-04T00:00:00.000Z','2026-09-04T00:00:00.000Z','d','1.0.0','','']);
      b.Ledger.push(['OY-VOID1','idemvoid1','VOID','YARD A','','WIDGET-C',100,0,'GOOD','','','','Cancelled OY-OPEN1','Harish','2026-09-05T00:00:00.000Z','2026-09-05T00:00:00.000Z','d','1.0.0','OY-OPEN1','OPENING']);
      return b;})(),
    "rebuildSnapshot_()");
run('rebuildSnapshot: OPENING then VOID then OPENING again rebuilds to opening_done TRUE', (()=>{const b=fullBook();
      b.Ledger.push(['OY-OPEN1','idemopen1','OPENING','YARD A','','WIDGET-C',100,0,'GOOD','','','','','Harish','2026-09-04T00:00:00.000Z','2026-09-04T00:00:00.000Z','d','1.0.0','','']);
      b.Ledger.push(['OY-VOID1','idemvoid1','VOID','YARD A','','WIDGET-C',100,0,'GOOD','','','','Cancelled OY-OPEN1','Harish','2026-09-05T00:00:00.000Z','2026-09-05T00:00:00.000Z','d','1.0.0','OY-OPEN1','OPENING']);
      b.Ledger.push(['OY-OPEN2','idemopen2','OPENING','YARD A','','WIDGET-C',80,0,'GOOD','','','','','Harish','2026-09-06T00:00:00.000Z','2026-09-06T00:00:00.000Z','d','1.0.0','','']);
      return b;})(),
    "rebuildSnapshot_()");
run('setup adds the Facilities tab to a populated book', (()=>{const b=fullBook(); delete b.Facilities; return b;})(),
    "ensureTabs_()", ['Facilities']);

/* ------------------------------------------------------------------- *
 * The schema gate. gas/ refuses a write, and every column-sensitive
 * read, unless the book says schema_version >= 2 AND the live Ledger
 * header is the one the code expects. These two scenarios exist because
 * that gate is now the only thing standing between this code and a
 * ledger written down the wrong columns — and a gate nobody exercises
 * is a gate nobody notices has stopped working.
 * ------------------------------------------------------------------- */

/** The book as it stands on the live Sheet TODAY: still schema_version 1. */
function v1Book(){ const b = fullBook(); b.Meta[1] = ['schema_version',1]; return b; }

/**
 * Meta says 2 but the Ledger header is still the old S01 17-column shape —
 * i.e. somebody bumped the number without running the migration. A version
 * number must not be able to lie about the header, so this must ALSO refuse.
 */
function lyingHeaderBook(){
  const b = fullBook();
  b.Ledger = [['txn_id','idem_key','txn_type','sku','qty','damaged_qty','condition','ref_no','location','remarks','recorded_by','client_ts','server_ts','device_id','app_version','void_of_txn_id','void_of_type'],
              ['OY-ORIG1','idemorig1','INBOUND','WIDGET-A',40,3,'GOOD','R1','L1','','Harish','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','d','1.0.0','','']];
  return b;
}

run('schema_version 1 refuses a write, and the refusal is RETRYABLE', v1Book(),
    "submitTxnBatch_({txns:[{idemKey:'schema00001',type:'INBOUND',facility:'YARD A',sku:'WIDGET-A',qty:1,damagedQty:0,recordedBy:'Harish'}]})",
    ['Ledger']);
run('Meta says 2 but the Ledger header is the OLD 17-column shape — still refused', lyingHeaderBook(),
    "submitTxnBatch_({txns:[{idemKey:'schema00002',type:'INBOUND',facility:'YARD A',sku:'WIDGET-A',qty:1,damagedQty:0,recordedBy:'Harish'}]})",
    ['Ledger']);
