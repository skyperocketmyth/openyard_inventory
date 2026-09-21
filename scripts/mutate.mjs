/**
 * Mutation runner — proves the browser suites can actually FAIL.
 *
 * Run:  node scripts/mutate.mjs                 (npm run mutate)
 *       node scripts/mutate.mjs verify-activity (one suite only)
 *       node scripts/mutate.mjs --list          (show the cases, run nothing)
 *
 * WHY THIS EXISTS. scripts/verify-activity.mjs passed 39 of 39 on its first
 * run. Three hand-made mutations later, one of them turned out to be caught
 * only by a cosmetic assertion while the dangerous consequence sailed through
 * green. A suite's own green run tells you nothing about whether it can go
 * red, and "break it on purpose and see" is too easy to skip. This makes it a
 * command.
 *
 * WHAT IT DOES, per case in scripts/mutations.mjs:
 *   1. read the target file and remember its exact bytes
 *   2. assert the `find` string appears EXACTLY ONCE, then replace it
 *   3. run the named suite and collect which checks went red
 *   4. restore the file and VERIFY the restore byte-for-byte
 *   5. fail the case if any `expect`ed check stayed green
 *
 * THE FILE IS ALWAYS RESTORED. Every case runs inside try/finally, the restore
 * is verified against a hash rather than assumed, and a failed restore aborts
 * the whole run loudly instead of moving on to the next case with a mutated
 * working tree. SIGINT is trapped for the same reason — a Ctrl-C halfway
 * through must not leave `// MUTANT` in a file that then gets committed.
 *
 * It refuses to start on a dirty working tree for the files it is going to
 * touch: if a restore ever did go wrong, the recovery is `git checkout` on
 * those files, and that is only safe when there was nothing else in them.
 *
 * READING A `SURVIVED` VERDICT — it means one of two things, and this script
 * CANNOT tell them apart:
 *   (a) the suite has a hole, or
 *   (b) the mutation compiled but did not actually change behaviour.
 * (b) happened on the first real run. The across-yard case replaced
 * `projectedFor(fac, sku)` with `projected().find(x => x.sku === sku)`, which
 * LOOKS like the classic across-warehouse bug — but rows are sorted facility
 * then sku, so `.find` returned YARD A's row, the correct answer, and nothing
 * moved. It reported SURVIVED and sent me hunting a hole that did not exist.
 * So on SURVIVED, prove the mutant is real first: apply it by hand and watch
 * the wrong number appear on screen. Only then go looking at the suite.
 *
 * AND DO NOT PIPE THIS. `node scripts/mutate.mjs | tail` reports tail's exit
 * code, not this script's, so a run with survivors looks like a pass to CI and
 * to anything reading `$?`. Redirect to a file instead: `> out.txt 2>&1`.
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import CASES from './mutations.mjs';

const ARGS = process.argv.slice(2);
const LIST_ONLY = ARGS.includes('--list');
const ONLY_SUITE = ARGS.find(a => !a.startsWith('-'));
const URL_UNDER_TEST = 'http://127.0.0.1:8787/';
const SERVE_PORT = 8787;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = s => createHash('sha256').update(s).digest('hex');
const bold = s => `\x1b[1m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;
const green = s => `\x1b[32m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;

const cases = CASES.filter(c => !ONLY_SUITE || c.suite === ONLY_SUITE);

if (LIST_ONLY) {
  console.log(`\n${bold('Mutation cases')}\n`);
  for (const c of cases) {
    console.log(`  ${c.suite}  ${bold(c.name)}`);
    console.log(dim(`      why:    ${c.why}`));
    console.log(dim(`      expect: ${c.expect.join(' / ')}`));
  }
  console.log(`\n${cases.length} case(s).\n`);
  process.exit(0);
}
if (!cases.length) {
  console.error(`\nNo mutation cases match "${ONLY_SUITE}".\n`);
  process.exit(1);
}

/* ---- refuse to run on a dirty tree, for the files we will touch ---- */
const targets = [...new Set(cases.map(c => c.file))];
try {
  const dirty = execFileSync('git', ['status', '--porcelain', '--', ...targets],
    { encoding: 'utf8' }).trim();
  if (dirty) {
    console.error(`\n${red('Refusing to run: uncommitted changes in a file this would mutate.')}`);
    console.error(dirty);
    console.error('\nCommit or stash first. If a restore ever fails, recovery is');
    console.error('`git checkout -- <file>`, and that is only safe when the file was clean.\n');
    process.exit(1);
  }
} catch (err) {
  console.error(`\n${red('Could not ask git whether the tree is clean:')} ${err.message}\n`);
  process.exit(1);
}

/* ---- the originals, and a restore that cannot be skipped ---- */
const originals = new Map();
for (const f of targets) {
  const text = readFileSync(f, 'utf8');
  originals.set(f, { text, sha: hash(text) });
}
let restoreFailed = null;
function restore(file) {
  const o = originals.get(file);
  writeFileSync(file, o.text);
  const now = hash(readFileSync(file, 'utf8'));
  if (now !== o.sha) {
    restoreFailed = file;
    console.error(`\n${red(`FATAL: could not restore ${file}.`)}`);
    console.error(`Run: git checkout -- ${file}\n`);
    return false;
  }
  return true;
}
function restoreAll() {
  for (const f of targets) {
    const o = originals.get(f);
    if (hash(readFileSync(f, 'utf8')) !== o.sha) restore(f);
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} — restoring files before exit.`);
    restoreAll();
    process.exit(130);
  });
}

/* ---- the static server, started only if nothing is already serving ---- */
let serveProc = null;
async function serverUp() {
  try {
    const r = await fetch(URL_UNDER_TEST, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}
async function ensureServer() {
  if (await serverUp()) return false;
  serveProc = spawn(process.execPath, ['scripts/serve.mjs', 'docs', String(SERVE_PORT)],
    { stdio: 'ignore' });
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    if (await serverUp()) return true;
  }
  throw new Error(`nothing is serving docs/ on ${URL_UNDER_TEST} and it could not be started`);
}

/**
 * Run a suite and return which checks passed and which failed.
 * A non-zero exit is expected — the whole point is that it fails.
 */
function runSuite(suite) {
  // Two kinds of suite, because the logic worth mutating lives in both places.
  // A `test/...` name is a node:test file (the date and window arithmetic); a
  // bare name is a CDP browser script under scripts/. They report differently,
  // so each gets its own parser rather than one loose regex that half-works on
  // both and quietly finds no checks at all.
  const isUnit = suite.startsWith('test/');
  const args = isUnit
    ? ['--test', suite]
    : [`scripts/${suite}.mjs`, URL_UNDER_TEST];
  return new Promise(resolve => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => {
      let failed, passed;
      if (isUnit) {
        // TAP: "ok 3 - name" / "not ok 3 - name". The `not ok` pattern has to
        // be tried FIRST and excluded from the pass pattern, or every failure
        // is counted as a pass as well.
        failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1].trim());
        passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map(m => m[1].trim());
      } else {
        failed = [...out.matchAll(/^\s*FAIL\s+(.+)$/gm)].map(m => m[1].trim());
        passed = [...out.matchAll(/^\s*PASS\s+(.+)$/gm)].map(m => m[1].trim());
      }
      resolve({ code, failed, passed, ran: passed.length + failed.length, out });
    });
  });
}

/* ---- baseline: every suite must be green BEFORE anything is mutated ---- */
let cleanedUpServer = false;
const finish = (codeOut) => {
  restoreAll();
  if (serveProc && !cleanedUpServer) { cleanedUpServer = true; try { serveProc.kill(); } catch {} }
  process.exit(restoreFailed ? 2 : codeOut);
};

try {
  const started = await ensureServer();
  console.log(`\n${bold('Mutation run')} against ${URL_UNDER_TEST}`
    + dim(started ? '  (started docs/ server)' : '  (using the server already up)'));

  const suites = [...new Set(cases.map(c => c.suite))];
  console.log(`\n${bold('Baseline')} — every suite must be green before anything is broken\n`);
  const baseline = new Map();
  for (const s of suites) {
    const r = await runSuite(s);
    baseline.set(s, r);
    const okNow = r.failed.length === 0 && r.ran > 0;
    console.log(`  ${okNow ? green('OK  ') : red('BAD ')} ${s}: ${r.ran} checks, ${r.failed.length} failing`);
    if (!okNow) {
      console.error(`\n${red('Baseline is not green.')} Fix the suite first — a mutation run`);
      console.error('against an already-failing suite cannot tell you anything.\n');
      if (r.failed.length) console.error('  failing: ' + r.failed.join('\n           '));
      finish(1);
    }
  }

  /* ---- the cases ---- */
  console.log(`\n${bold('Cases')}\n`);
  let survived = 0;
  const results = [];

  for (const c of cases) {
    const o = originals.get(c.file);
    let outcome;
    try {
      const count = o.text.split(c.find).length - 1;
      if (count !== 1) {
        outcome = {
          verdict: 'STALE',
          detail: `its \`find\` string appears ${count} times in ${c.file}, not once — `
            + 'the code it targets has been reworded, so this case is no longer testing anything'
        };
      } else {
        writeFileSync(c.file, o.text.replace(c.find, c.replace));
        const r = await runSuite(c.suite);

        if (r.ran === 0) {
          // The suite could not complete. That IS detection, but no named
          // check owns it, so it is reported separately rather than as a pass.
          outcome = { verdict: 'CRASH', detail: 'the suite could not run to completion' };
        } else {
          const stillGreen = c.expect.filter(label =>
            !r.failed.some(f => f.includes(label)));
          const collateral = r.failed.filter(f =>
            !c.expect.some(label => f.includes(label)));
          outcome = stillGreen.length
            ? { verdict: 'SURVIVED', stillGreen, collateral, r }
            : { verdict: 'CAUGHT', collateral, r };
        }
      }
    } finally {
      if (!restore(c.file)) finish(2);
    }

    results.push({ c, outcome });
    const v = outcome.verdict;
    if (v === 'CAUGHT') {
      console.log(`  ${green('CAUGHT  ')} ${c.name}`);
      console.log(dim(`            ${c.expect.length} expected check(s) went red`
        + (outcome.collateral?.length ? `, plus ${outcome.collateral.length} more` : '')));
    } else if (v === 'CRASH') {
      survived++;
      console.log(`  ${red('CRASH   ')} ${c.name}`);
      console.log(dim(`            ${outcome.detail} — detected, but no named check owns it.`));
      console.log(dim('            Give the suite a check that fails cleanly here.'));
    } else if (v === 'STALE') {
      survived++;
      console.log(`  ${red('STALE   ')} ${c.name}`);
      console.log(dim(`            ${outcome.detail}`));
    } else {
      survived++;
      console.log(`  ${red('SURVIVED')} ${c.name}`);
      console.log(dim(`            why it matters: ${c.why}`));
      for (const label of outcome.stillGreen) {
        console.log(`            ${red('still green:')} ${label}`);
      }
      if (outcome.collateral.length) {
        console.log(dim(`            (something else did notice: ${outcome.collateral.join('; ')})`));
        console.log(dim('             a cosmetic check catching it is not the same as coverage'));
      }
    }
  }

  /* ---- verdict ---- */
  const caught = results.filter(r => r.outcome.verdict === 'CAUGHT').length;
  console.log(`\n${bold('Result')}  ${caught}/${cases.length} mutations caught by the check that should catch them\n`);
  if (survived) {
    console.log(red('Every SURVIVED / CRASH / STALE line above is a hole in the suite,'));
    console.log(red('not a problem with the code. The mutation was deliberate.\n'));
  }
  finish(survived ? 1 : 0);
} catch (err) {
  console.error(`\n${red('mutate could not run:')} ${err.message}\n`);
  finish(1);
}
