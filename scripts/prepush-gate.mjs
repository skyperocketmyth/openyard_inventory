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
try {
  execFileSync(process.execPath,
    ['--test', 'test/deltas.test.mjs', 'test/sync.test.mjs'], { stdio: 'pipe' });
  notes.push('unit tests pass (client + server delta lists agree, adoption gate holds)');
} catch {
  problems.push('unit tests FAILED — run `npm test`. The client and server balance maths may have drifted.');
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
    } else {
      notes.push(`docs/ changes include a sw.js bump (${changed.length} file(s) changed)`);
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

/* ------------------------------------------------------------------------ */
for (const nt of notes) console.log(`  ok   ${nt}`);
if (problems.length) {
  console.error('\nPRE-PUSH GATE FAILED:');
  for (const p of problems) console.error(`  FAIL ${p}`);
  process.exit(1);
}
console.log('\nPre-push gate passed.');
