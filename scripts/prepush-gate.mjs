/**
 * Pre-push gate. Run before every push (`npm run gate`, or via `npm run push`).
 *
 * Every check here exists because the thing it checks for actually broke once
 * on this project or a previous one. None of them are hypothetical.
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const problems = [];
// A blocker is NOT a defect. It is unfinished work that would be unsafe to push
// yet — reported separately so "the gate is red" can be read at a glance as
// either "something is broken" or "this stage is not finished". Both still stop
// a push; conflating them is how a real fault hides behind an expected one.
const blockers = [];
const notes = [];
const firstLines = (s, n) =>
  String(s).split(/\r?\n/).filter(Boolean).slice(0, n).join(' | ');

/* 1. the manifest must declare a web app entry point ---------------------- */
// `clasp push` REPLACES the remote appsscript.json. A manifest missing its
// `webapp` block silently republishes the project as a library, and /exec then
// serves Drive's "unable to open the file" page — at HTTP 200, so a status-code
// health check calls it healthy. This project arrived with the block missing.
const manifestPath = 'gas/appsscript.json';
if (!existsSync(manifestPath)) {
  problems.push(`${manifestPath} is missing`);
} else {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!m.webapp) {
    problems.push(`${manifestPath} has no "webapp" block — pushing would republish this project as a LIBRARY and kill the /exec URL`);
  } else {
    if (m.webapp.executeAs !== 'USER_DEPLOYING') {
      problems.push(`webapp.executeAs is "${m.webapp.executeAs}", expected USER_DEPLOYING`);
    }
    if (m.webapp.access !== 'ANYONE_ANONYMOUS') {
      problems.push(`webapp.access is "${m.webapp.access}", expected ANYONE_ANONYMOUS (this is what removes the login)`);
    }
    notes.push(`webapp: executeAs=${m.webapp.executeAs} access=${m.webapp.access}`);
  }
}

/* 2. a doGet/doPost must actually exist ----------------------------------- */
const code = existsSync('gas/Code.js') ? readFileSync('gas/Code.js', 'utf8') : '';
if (!/function\s+doPost\s*\(/.test(code)) problems.push('gas/Code.js defines no doPost()');
if (!/function\s+doGet\s*\(/.test(code)) problems.push('gas/Code.js defines no doGet()');

/* 3. the delta contract must still agree across both halves --------------- */
// The file list is READ OUT OF package.json rather than repeated here.
//
// It used to be a second copy kept in step by hand, with a comment saying so,
// and it drifted anyway: test/outbox.test.mjs was added to package.json in S03
// and never to this list, so the head-of-line ordering tests — the coverage for
// a bug that had gone unnoticed through two reviews — passed `npm test` and
// were never once enforced on a push. Deriving the list means the gate runs
// whatever the project calls its test suite, and a file can no longer be
// invisible to it.
let testFiles = [];
try {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  testFiles = String((pkg.scripts && pkg.scripts.test) || '')
    .split(/\s+/).filter(f => /^test\/.+\.mjs$/.test(f));
} catch { /* reported just below as "no test files" */ }

if (!testFiles.length) {
  problems.push('could not read the test file list out of package.json "scripts.test" — the gate would be running no tests at all');
} else {
  const missing = testFiles.filter(f => !existsSync(f));
  if (missing.length) {
    problems.push(`package.json lists test files that do not exist: ${missing.join(', ')}`);
  }
  try {
    execFileSync(process.execPath, ['--test', ...testFiles], { stdio: 'pipe' });
    notes.push(`unit tests pass across ${testFiles.length} files (client + server delta lists agree, adoption gate holds, validateTxn_ still refuses negative stock, a written ledger row still lines up with its header, the outbox keeps its per-yard ordering and only strands entries that can never send)`);
  } catch {
    problems.push('unit tests FAILED — run `npm test`. The client and server balance maths may have drifted.');
  }
}

/* 4. the app's inline module must PARSE ----------------------------------- */
// A syntax error here serves HTTP 200 and a dead app, so curl sees nothing
// wrong. Exactly this shipped once: an escaped apostrophe terminated a string
// early and the app never booted.
const html = existsSync('docs/index.html') ? readFileSync('docs/index.html', 'utf8') : '';
if (!html) {
  problems.push('docs/index.html is missing');
} else {
  const inline = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  if (!inline) {
    problems.push('docs/index.html has no inline <script type="module"> block');
  } else {
    const tmp = join(tmpdir(), `oy-gate-${process.pid}.mjs`);
    // Strip the relative imports — checking OUR syntax, not resolving modules.
    writeFileSync(tmp, inline[1].replace(/^import .*?;$/gm, ''), 'utf8');
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      notes.push('docs/index.html inline module parses');
    } catch (err) {
      problems.push('docs/index.html inline module has a SYNTAX ERROR: '
        + firstLines(err.stderr || err.message, 3));
    } finally {
      try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    }
  }

  /* 5. the client modules must parse too ---------------------------------- */
  for (const f of ['deltas', 'idb', 'api', 'outbox', 'sync']) {
    const path = `docs/lib/${f}.js`;
    if (!existsSync(path)) { problems.push(`${path} is missing`); continue; }
    try {
      execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    } catch (err) {
      problems.push(`${path} has a SYNTAX ERROR: ${firstLines(err.stderr || err.message, 2)}`);
    }
  }

  /* 6. the viewport meta must be present ---------------------------------- */
  // Without it a phone lays the page out at 980px and zooms out, making every
  // size in the design meaningless. This shipped once too.
  if (!/<meta\s+name="viewport"/.test(html)) {
    problems.push('docs/index.html has no <meta name="viewport"> — the phone will lay out at 980px and zoom out');
  } else {
    notes.push('viewport meta present');
  }
}

/* 7. the service worker cache must be bumped when docs/ changes ----------- */
// If docs/ changed but CACHE did not, existing installs keep the old build and
// the change looks like it never deployed.
try {
  const changed = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'docs/'],
    { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
  if (changed.length) {
    const swChanged = changed.includes('docs/sw.js');
    const otherChanged = changed.some(f => f !== 'docs/sw.js');
    if (otherChanged && !swChanged) {
      problems.push(`docs/ changed (${changed.join(', ')}) but docs/sw.js did not — bump CACHE in docs/sw.js or phones keep serving the old build`);
    } else if (otherChanged) {
      // sw.js appearing in the diff is NOT proof the cache name moved — editing
      // a comment in it used to satisfy this check while leaving every install
      // pinned to the old build. Compare the actual CACHE string against HEAD.
      const cacheOf = src => (src.match(/CACHE\s*=\s*['"]([^'"]+)['"]/) || [])[1] || null;
      const now = cacheOf(readFileSync('docs/sw.js', 'utf8'));
      let head = null;
      try {
        head = cacheOf(execFileSync('git', ['show', 'HEAD:docs/sw.js'], { encoding: 'utf8' }));
      } catch { /* sw.js is new in this commit — nothing to compare */ }
      if (!now) {
        problems.push('docs/sw.js has no recognisable CACHE = "..." constant');
      } else if (head && head === now) {
        problems.push(`docs/ changed and docs/sw.js was touched, but CACHE is still '${now}' — bump it or phones keep serving the old build`);
      } else {
        notes.push(`sw.js CACHE bumped${head ? ` ${head} -> ${now}` : ` to ${now}`} (${changed.length} docs file(s) changed)`);
      }
    } else {
      notes.push(`only docs/sw.js changed (${changed.length} file(s))`);
    }
  }
} catch { /* no HEAD yet — first commit */ }

/* 8. the Sheet id must not be a placeholder ------------------------------- */
const sheetId = (code.match(/var\s+SHEET_ID\s*=\s*'([^']+)'/) || [])[1];
if (!sheetId || sheetId.length < 20) {
  problems.push('SHEET_ID in gas/Code.js does not look like a real Sheet id');
} else {
  notes.push(`SHEET_ID ...${sheetId.slice(-8)}`);
}

/* 9. the app must point at the deployment we actually deployed ------------ */
const scriptUrl = (html.match(/const SCRIPT_URL\s*=\s*'([^']+)'/) || [])[1];
if (!scriptUrl || !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(scriptUrl)) {
  problems.push('SCRIPT_URL in docs/index.html is not a valid /exec URL');
} else if (existsSync('.exec_url')) {
  const expected = readFileSync('.exec_url', 'utf8').trim();
  if (expected && expected !== scriptUrl) {
    problems.push('SCRIPT_URL in docs/index.html does not match .exec_url — the app would call a stale deployment');
  } else {
    notes.push('SCRIPT_URL matches the recorded deployment');
  }
}

/* 10. gas/ must not require a warehouse before the app can supply one ----- */
// This one is here because the ONLY thing standing between this branch and a
// yard-wide outage is a human remembering the deploy order.
//
// The server now refuses any entry that arrives with no warehouse on it
// (UNKNOWN_FACILITY, gas/Ledger.js). The app cannot put a warehouse on an
// entry until S03 ships the picker — until then `uiFacility` is a fixed empty
// string that nothing ever sets. Push gas/ while that is still true and every
// single entry the yard records is rejected, permanently and immediately.
//
// It clears itself: the moment S03 assigns to `uiFacility` anywhere in
// docs/index.html, or replaces the empty-string stub with a real initialiser,
// this check goes quiet. No flag to remember, no date to expire.
const ledgerSrc = existsSync('gas/Ledger.js') ? readFileSync('gas/Ledger.js', 'utf8') : '';
if (/UNKNOWN_FACILITY/.test(ledgerSrc) && html) {
  const assigns = (html.match(/\buiFacility\s*\+?=(?!=)/g) || []).length;
  const declares = (html.match(/\b(?:let|const|var)\s+uiFacility\s*=(?!=)/g) || []).length;
  const stillAStub = /\blet\s+uiFacility\s*=\s*''\s*;/.test(html);
  if (stillAStub && assigns - declares <= 0) {
    blockers.push(
      'the warehouse picker is not wired up yet. gas/Ledger.js already refuses any entry '
      + 'that arrives without a warehouse, but docs/index.html still has uiFacility fixed at '
      + "'' and nothing anywhere sets it — so if you push gas/ now, every entry the yard "
      + 'records will be rejected. Finish S03 (make the picker set uiFacility) before pushing.');
  } else {
    notes.push('the app supplies a warehouse on every entry, so the server may require one');
  }
}

/* ------------------------------------------------------------------------ */
for (const nt of notes) console.log(`  ok   ${nt}`);
if (problems.length) {
  console.error('\nPRE-PUSH GATE FAILED:');
  for (const p of problems) console.error(`  FAIL ${p}`);
}
if (blockers.length) {
  console.error('\nNOT READY TO PUSH — nothing is broken, this work is unfinished:');
  for (const b of blockers) console.error(`  WAIT ${b}`);
}
if (problems.length || blockers.length) process.exit(1);
console.log('\nPre-push gate passed.');
