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
 * It covers ~23 action paths including setup on an empty book, a missing Meta
 * tab, rebuildSnapshot, purgeTestData, voidTxn, duplicate-idem replay,
 * read_only, and an all-rejected batch.
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
    Ledger:[['txn_id','idem_key','txn_type','sku','qty','damaged_qty','condition','ref_no','location','remarks','recorded_by','client_ts','server_ts','device_id','app_version','void_of_txn_id','void_of_type'],
            ['OY-ORIG1','idemorig1','INBOUND','WIDGET-A',40,3,'GOOD','R1','L1','','Harish','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','d','1.0.0','',''],
            ['OY-ORIG2','idemorig2','DAMAGE','WIDGET-B',5,0,'','','','','Harish','2026-09-02T00:00:00.000Z','2026-09-02T00:00:00.000Z','d','1.0.0','','']],
    Users:[['name','active','added_ts'],['Harish',true,'t'],['Old Hand',false,'t']],
    Meta:[['key','value'],['schema_version',1],['ledger_epoch',7],['items_epoch',3],['read_only','FALSE']],
    Balance_Snapshot:[['sku','total_qty','damaged_qty','good_qty','last_txn_ts','updated_ts'],
                      ['WIDGET-A',40,3,37,'2026-09-01T00:00:00.000Z','t'],
                      ['WIDGET-B',50,5,45,'2026-09-02T00:00:00.000Z','t']],
    Rejections:[['server_ts','idem_key','recorded_by','device_id','payload_json','error_code','error_message']]
  };
}

function run(label, book, expr){
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
  for(const k of ['Meta','Users','Balance_Snapshot'])
    if(book[k]) console.log('   '+k+' = '+JSON.stringify(book[k].map(r=>r.slice(0,4))));
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
    "submitTxnBatch_({txns:[{idemKey:'zzzzzzzz01',type:'INBOUND',sku:'WIDGET-A',qty:1,recordedBy:'Harish'}]})");
run('duplicate idem key replays', fullBook(),
    "submitTxnBatch_({txns:[{idemKey:'idemorig1',type:'INBOUND',sku:'WIDGET-A',qty:40,damagedQty:3,recordedBy:'Harish'}]})");
run('all-rejected batch still replies balances', fullBook(),
    "submitTxnBatch_({txns:[{idemKey:'yyyyyyyy01',type:'OUTBOUND',sku:'WIDGET-A',qty:9999,recordedBy:'Harish'}]})");
run('missing Meta tab -> needsSetup', (()=>{const b=fullBook(); delete b.Meta; return b;})(),
    "doGet({parameter:{action:'ping'}})");
