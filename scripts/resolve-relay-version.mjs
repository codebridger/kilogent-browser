#!/usr/bin/env node
/**
 * Decide `remote-browser-relay`'s next version from the commits since its last release.
 *
 * WHAT THIS REPLACES. The version used to be typed by hand into
 * `packages/relay/package.json`, and `a hand-typed version guard` existed to stop
 * someone forgetting — because the publish job is idempotent, so a forgotten bump was INVISIBLE:
 * every check green, deploy green, release green, and `npm i -g <pkg>@latest` quietly
 * handing out the old binary. That is how the §8.1 Ship key shipped while every connected daemon
 * was told to upgrade to a version that did not exist.
 *
 * Deriving the version removes the step that could be forgotten, so the guard retires with it.
 *
 * THE ONE DETAIL THAT KEEPS IT SAFE. The PATH FILTER decides *whether* to release; the commit type
 * only decides *how big* the bump is. Any commit touching the published surface releases, and an
 * unrecognised or non-releasing type (`chore`, `ci`, `refactor`, an unparseable subject) falls
 * through to PATCH rather than to "no release". Doing it the conventional way round — where only
 * `feat`/`fix` release — would reintroduce exactly the silent failure the old guard existed for,
 * because a `refactor(relay):` that changes the bundle would publish nothing.
 *
 * THE BOUNDARY IS npm's OWN RECORD, not a git tag. `npm view <pkg>@<version> gitHead` returns the
 * commit each version was published from, so there is nothing to tag, nothing to push, and the job
 * keeps `contents: read`. It also cannot drift from what was actually published, which a tag can.
 *
 * PUBLISHED SURFACE is `packages/crew/runner/**` plus `packages/crew/shared/**` — `build.mjs`
 * BUNDLES the shared package into `dist/cli.js` (it is workspace-private and could never resolve
 * from the registry), so a shared-only change ships inside the tarball just as surely as a runner
 * one. Same two paths the release workflow filters its `dev` channel on.
 *
 * PRE-1.0 IS DELIBERATE. While the major is 0, a breaking change bumps the MINOR rather than
 * jumping to 1.0.0 — semantic-release's own default, and the conservative reading of SemVer §4.
 * Reaching 1.0.0 should be somebody's decision, not a `!` in a commit subject.
 *
 * Usage:
 *   node scripts/resolve-relay-version.mjs              # print JSON for the workflow
 *   node scripts/resolve-relay-version.mjs --preview     # human-readable, for CI on a PR
 *   node scripts/resolve-relay-version.mjs --self-test   # the pure logic, no git, no network
 */
import { execSync } from 'node:child_process';

const PKG = 'remote-browser-relay';
const PATHS = ['packages/relay'];

/** Record/field separators — chosen because neither can appear in a commit message. */
const RS = '\x1e';
const FS_ = '\x1f';

/**
 * The conventional-commit header. Everything after the colon is prose we do not read.
 * `feat(relay)!: …` → {type:'feat', breaking:true}
 */
export function parseSubject(subject) {
  const m = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s/.exec(subject ?? '');
  if (!m) return { type: null, scope: null, breaking: false };
  return { type: m[1].toLowerCase(), scope: m[2] ?? null, breaking: Boolean(m[3]) };
}

/**
 * The largest bump any one commit asks for — never "none". See the docblock: the caller has already
 * established that the published surface changed, so the only question left is how big.
 */
export function bumpFor(commits) {
  let bump = 'patch';
  for (const c of commits) {
    const { type, breaking } = parseSubject(c.subject);
    if (breaking || /^BREAKING[ -]CHANGE:/m.test(c.body ?? '')) return 'major';
    if (type === 'feat') bump = 'minor';
  }
  return bump;
}

/** Apply a bump to a SemVer core, with the pre-1.0 rule above. */
export function nextVersion(base, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(base);
  if (!m) throw new Error(`not a SemVer version: ${base}`);
  let [major, minor, patch] = m.slice(1).map(Number);
  const effective = bump === 'major' && major === 0 ? 'minor' : bump;
  if (effective === 'major') return `${major + 1}.0.0`;
  if (effective === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// ---------------------------------------------------------------------------------------------
// Self-test — the pure half, so the release path's arithmetic is not first exercised in production.
// ---------------------------------------------------------------------------------------------
function selfTest() {
  const cases = [];
  const eq = (name, actual, expected) =>
    cases.push([name, JSON.stringify(actual) === JSON.stringify(expected), actual, expected]);

  eq('parses a plain type', parseSubject('fix: a thing').type, 'fix');
  eq('parses a scope', parseSubject('feat(relay): a thing').scope, 'relay');
  eq('parses the breaking bang', parseSubject('feat(relay)!: a thing').breaking, true);
  eq('a non-conventional subject has no type', parseSubject('just some words').type, null);
  eq('requires the space after the colon', parseSubject('fix:no-space').type, null);

  eq('feat is a minor', bumpFor([{ subject: 'feat: x' }]), 'minor');
  eq('fix is a patch', bumpFor([{ subject: 'fix: x' }]), 'patch');
  eq('the bang is a major', bumpFor([{ subject: 'feat!: x' }]), 'major');
  eq(
    'a BREAKING CHANGE footer is a major',
    bumpFor([{ subject: 'fix: x', body: 'BREAKING CHANGE: y' }]),
    'major',
  );
  eq('the largest bump wins', bumpFor([{ subject: 'fix: a' }, { subject: 'feat: b' }]), 'minor');
  // THE SAFETY PROPERTY: anything unrecognised still releases, as a patch.
  eq('chore still releases as a patch', bumpFor([{ subject: 'chore: x' }]), 'patch');
  eq('refactor still releases as a patch', bumpFor([{ subject: 'refactor(relay): x' }]), 'patch');
  eq('an unparseable subject still releases', bumpFor([{ subject: 'oops' }]), 'patch');

  eq('patch increments', nextVersion('0.6.3', 'patch'), '0.6.4');
  eq('minor resets patch', nextVersion('0.6.3', 'minor'), '0.7.0');
  eq('pre-1.0 breaking stays pre-1.0', nextVersion('0.6.3', 'major'), '0.7.0');
  eq('post-1.0 breaking bumps major', nextVersion('1.2.3', 'major'), '2.0.0');
  eq('a prerelease base uses its core', nextVersion('0.6.3-dev.4', 'patch'), '0.6.4');

  let failed = 0;
  for (const [name, ok, actual, expected] of cases) {
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (!ok) console.log(`      got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
  if (failed > 0) {
    console.error(`\n❌ ${failed}/${cases.length} version-resolver self-tests failed.`);
    process.exit(1);
  }
  console.log(`\n✅ ${cases.length} version-resolver self-tests passed.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// The impure half. Guarded so the pure exports above can be imported without this firing — without
// the guard, `import { bumpFor }` shells out to npm and git and then process.exit()s the importer.
// ---------------------------------------------------------------------------------------------
const RUN_DIRECTLY = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (!RUN_DIRECTLY) {
  // Imported for its pure helpers (tests, other scripts): stop here.
} else if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  main();
}

function main() {
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryShell = (cmd) => {
  try {
    return sh(cmd);
  } catch {
    return '';
  }
};

const latest = tryShell(`npm view ${PKG} version`);
if (!latest) {
  // First publish ever: nothing to compare against, so package.json is the only answer.
  const seed = sh(`node -p "require('./packages/relay/package.json').version"`);
  emit({ release: true, version: seed, bump: 'seed', base: null, commits: [], reason: 'first publish' });
}

const head = tryShell(`npm view ${PKG}@${latest} gitHead`);
if (!head || !tryShell(`git cat-file -t ${head}`)) {
  // FAIL CLOSED. Without a boundary we cannot tell a runner change from a Support one, and guessing
  // would either over-bump or — far worse — publish nothing and say it succeeded, which is the
  // exact silent failure this script exists to make impossible.
  console.error(
    `✗ cannot resolve the boundary commit for ${PKG}@${latest}.\n` +
      `  npm reported gitHead=${head || '(none)'}, which this checkout cannot resolve.\n` +
      '  A shallow clone is the usual cause — fetch full history. If npm genuinely has no gitHead\n' +
      '  for that version, publish once with an explicit version to re-establish the boundary.',
  );
  process.exit(1);
}

const raw = tryShell(
  `git log ${head}..HEAD --format=${RS}%s${FS_}%b -- ${PATHS.map((p) => `'${p}'`).join(' ')}`,
);
const commits = raw
  .split(RS)
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => {
    const [subject, body = ''] = r.split(FS_);
    return { subject: subject.trim(), body: body.trim() };
  });

if (commits.length === 0) {
  emit({
    release: false,
    version: latest,
    bump: 'none',
    base: latest,
    commits: [],
    reason: 'no commit since the last release touched the published surface',
  });
}

const bump = bumpFor(commits);
emit({
  release: true,
  version: nextVersion(latest, bump),
  bump,
  base: latest,
  commits: commits.map((c) => c.subject),
  reason: `${commits.length} commit(s) touched the published surface`,
});
}

function emit(result) {
  if (process.argv.includes('--preview')) {
    console.log(`\n${PKG}`);
    console.log(`  last published : ${result.base ?? '(never)'}`);
    console.log(`  bump           : ${result.bump}`);
    console.log(`  next version   : ${result.release ? result.version : '(no release)'}`);
    console.log(`  why            : ${result.reason}`);
    if (result.commits.length > 0) {
      console.log('  commits:');
      for (const c of result.commits) console.log(`    · ${c}`);
    }
    console.log();
  } else {
    console.log(JSON.stringify(result));
  }
  process.exit(0);
}
