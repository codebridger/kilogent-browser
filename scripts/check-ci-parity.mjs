#!/usr/bin/env node
// Does `npm test` actually run everything CI gates on?
//
// THE CLAIM THIS DEFENDS. `npm test` is supposed to be exactly what CI runs, so a green laptop
// cannot mean a red build. That claim has been true, then quietly false, then true again — it broke
// when a lock file drifted and every local lane passed while `npm ci` refused to start, and it
// would break again the moment somebody adds a step to ci.yml and not to `npm test`.
//
// So it is checked rather than asserted in a comment. Both sides are read from the files that
// actually run: `.github/workflows/ci.yml` and package.json's `test` script.
//
// It deliberately does NOT go the other way. `npm test` may run MORE than CI — the point is that
// nothing CI gates on is missing locally, not that the two lists are identical.

import fs from 'node:fs';

const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
const test = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts.test ?? '';

/** Steps CI runs but does not gate on. `continue-on-error` cannot fail a build, so requiring it
 *  locally would be requiring something that is allowed to fail. */
const NOT_A_GATE = new Set(['versions']);

/** Every `npm run <script>` in ci.yml, minus the ones inside a continue-on-error step. */
function gatingScripts() {
  const out = new Set();
  // Split on step boundaries so a `continue-on-error` can be attributed to its own step.
  for (const step of ci.split(/\n      - /)) {
    if (/continue-on-error:\s*true/.test(step)) continue;
    for (const m of step.matchAll(/npm run ([a-z:]+)/g)) out.add(m[1]);
  }
  return [...out].filter((s) => !NOT_A_GATE.has(s)).sort();
}

const inTest = new Set([...test.matchAll(/npm run ([a-z:]+)/g)].map((m) => m[1]));
const gating = gatingScripts();
const missing = gating.filter((s) => !inTest.has(s));

for (const s of gating) console.log(`  ${inTest.has(s) ? '✓' : '✗'} ${s}`);

if (gating.length === 0) {
  console.error('\n✗ found no `npm run` steps in ci.yml at all — has it stopped calling scripts?');
  console.error('  Inline shell in CI is exactly what this check exists to prevent.');
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`\n✗ ci.yml gates on ${missing.length} script(s) that \`npm test\` does not run:`);
  for (const s of missing) console.error(`    ${s}`);
  console.error('\n  A laptop would be green while CI is red. Add them to the `test` script.');
  process.exit(1);
}
console.log(`\n✅ ci parity: \`npm test\` runs all ${gating.length} scripts ci.yml gates on.`);
