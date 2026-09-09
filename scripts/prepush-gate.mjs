/**
 * Pre-push gate. Run before every `clasp push` (npm run push does this).
 *
 * Exists because of one specific production outage: `clasp push` fully REPLACES
 * the remote appsscript.json. A local manifest missing its `webapp` block
 * silently un-publishes the web app, the next deploy ships a library, and the
 * /exec URL then serves Drive's "unable to open the file" page — at HTTP 200,
 * so a status-code health check reports it healthy.
 *
 * Cheap to run, and it has already caught a real missing block on this project.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const problems = [];
const notes = [];

/* 1. the manifest must declare a web app entry point ---------------------- */
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
  execFileSync(process.execPath, ['--test', 'test/deltas.test.mjs'], { stdio: 'pipe' });
  notes.push('delta contract tests pass (client + server case lists agree)');
} catch (err) {
  problems.push('delta contract tests FAILED — run `npm test` and read the output. '
    + 'The client and server balance maths may have drifted.');
}

/* 4. the Sheet id must not have been left as a placeholder ---------------- */
const sheetId = (code.match(/var\s+SHEET_ID\s*=\s*'([^']+)'/) || [])[1];
if (!sheetId || sheetId.length < 20) {
  problems.push('SHEET_ID in gas/Code.js does not look like a real Sheet id');
} else {
  notes.push(`SHEET_ID ...${sheetId.slice(-8)}`);
}

/* ------------------------------------------------------------------------ */
for (const n of notes) console.log(`  ok   ${n}`);
if (problems.length) {
  console.error('\nPRE-PUSH GATE FAILED:');
  for (const p of problems) console.error(`  FAIL ${p}`);
  process.exit(1);
}
console.log('\nPre-push gate passed.');
