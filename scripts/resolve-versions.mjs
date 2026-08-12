#!/usr/bin/env node
/**
 * Decide the next version of EVERY package in this repo, from the commits since each one's last
 * release.
 *
 * ONE SCRIPT FOR ALL PACKAGES, because a release here is a SNAPSHOT of the repo rather than one
 * package's event. A merge to main might change the relay, the extension, both, or neither, and the
 * release that follows has to state where all of them stand — otherwise somebody reading the
 * Releases page cannot tell which extension goes with which relay.
 *
 * PATH FILTERING IS PER PACKAGE, and it is what stops a relay-only change from republishing an
 * identical extension (and the reverse). The commit TYPE only decides how big the bump is:
 *
 *   feat            minor
 *   ! or BREAKING   major   (minor while the major is 0 — see below)
 *   anything else   patch
 *
 * ANYTHING UNRECOGNISED STILL RELEASES. `chore`, `ci`, `refactor`, an unparseable subject — all
 * fall through to a PATCH rather than to "no release". The conventional way round, where only
 * `feat`/`fix` release, means a `refactor(relay):` that changes the shipped bundle publishes
 * nothing and reports success — which is the silent failure this whole mechanism exists to prevent.
 *
 * PRE-1.0 IS DELIBERATE. While the major is 0, a breaking change bumps the MINOR rather than
 * jumping to 1.0.0 — semantic-release's own default. Reaching 1.0.0 should be somebody's decision.
 *
 * TWO PACKAGES, TWO BOUNDARIES, and the difference is not an inconsistency:
 *
 *   relay      npm's own `gitHead` for the published version. It cannot drift from what was
 *              actually published, which a tag can — a tag is written by us, `gitHead` is written
 *              by the registry at publish time.
 *   extension  the last `extension-v*` git tag. It is not published to any registry, so there is
 *              no external record to ask; the tag IS the record, and the release workflow pushes it
 *              only after the release succeeded.
 *
 * Usage:
 *   node scripts/resolve-versions.mjs             # JSON, for the workflow
 *   node scripts/resolve-versions.mjs --preview   # human-readable
 *   node scripts/resolve-versions.mjs --self-test # the pure logic, no git, no network
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

/** Record/field separators — chosen because neither can appear in a commit message. */
const RS = '\x1e';
const FS_ = '\x1f';

export const PACKAGES = [
  {
    key: 'extension',
    label: 'Chrome extension',
    paths: ['packages/extension'],
    /** Its version lives in the manifest, which is what Chrome and the Web Store read. */
    versionFile: 'packages/extension/manifest.json',
    tagPrefix: 'extension-v',
    npm: null,
  },
  {
    key: 'relay',
    label: 'remote-browser-relay',
    paths: ['packages/relay'],
    versionFile: 'packages/relay/package.json',
    tagPrefix: 'relay-v',
    npm: 'remote-browser-relay',
  },
];

/**
 * The conventional-commit header. Everything after the colon is prose we do not read.
 * `feat(relay)!: …` → {type:'feat', breaking:true}
 */
export function parseSubject(subject) {
  const m = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s/.exec(subject ?? '');
  if (!m) return { type: null, scope: null, breaking: false };
  return { type: m[1].toLowerCase(), scope: m[2] ?? null, breaking: Boolean(m[3]) };
}

/** The largest bump any one commit asks for — never "none". The caller has already established
 *  that the package's own paths changed, so the only question left is how big. */
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
  const [major, minor, patch] = m.slice(1).map(Number);
  const effective = bump === 'major' && major === 0 ? 'minor' : bump;
  if (effective === 'major') return `${major + 1}.0.0`;
  if (effective === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// ─── the impure half ─────────────────────────────────────────────────────────────────────────

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryShell = (cmd) => {
  try {
    return sh(cmd);
  } catch {
    return '';
  }
};

function currentVersion(spec) {
  return JSON.parse(fs.readFileSync(spec.versionFile, 'utf8')).version;
}

function commitsSince(boundary, paths) {
  const raw = tryShell(
    `git log ${boundary}..HEAD --format=${RS}%s${FS_}%b -- ${paths.map((p) => `'${p}'`).join(' ')}`,
  );
  return raw
    .split(RS)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [subject, body = ''] = r.split(FS_);
      return { subject: subject.trim(), body: body.trim() };
    });
}

/** Where this package's last release is anchored, or null if it has never had one. */
function boundaryFor(spec) {
  if (spec.npm) {
    const latest = tryShell(`npm view ${spec.npm} version`);
    if (!latest) return { kind: 'first', ref: null, base: null };
    const head = tryShell(`npm view ${spec.npm}@${latest} gitHead`);
    if (!head || !tryShell(`git cat-file -t ${head}`)) {
      // FAIL CLOSED. Without a boundary we cannot tell this package's changes from another's, and
      // guessing would either over-bump or — far worse — publish nothing and say it succeeded.
      return { kind: 'unresolvable', ref: head || null, base: latest };
    }
    return { kind: 'npm', ref: head, base: latest };
  }
  const tag = tryShell(`git describe --tags --match '${spec.tagPrefix}*' --abbrev=0`);
  if (!tag) return { kind: 'first', ref: null, base: null };
  return { kind: 'tag', ref: tag, base: tag.slice(spec.tagPrefix.length) };
}

function resolve(spec) {
  const current = currentVersion(spec);
  const boundary = boundaryFor(spec);

  if (boundary.kind === 'unresolvable') {
    return {
      key: spec.key,
      label: spec.label,
      error:
        `cannot resolve the boundary for ${spec.npm}@${boundary.base}: npm reports ` +
        `gitHead=${boundary.ref ?? '(none)'}, which this checkout cannot resolve. A shallow clone ` +
        `is the usual cause — fetch full history.`,
    };
  }

  if (boundary.kind === 'first') {
    return {
      key: spec.key,
      label: spec.label,
      release: true,
      version: current,
      current,
      bump: 'seed',
      base: null,
      commits: [],
      reason: 'first release — the version in the repo is the seed',
    };
  }

  const commits = commitsSince(boundary.ref, spec.paths);
  if (commits.length === 0) {
    return {
      key: spec.key,
      label: spec.label,
      release: false,
      version: boundary.base,
      current,
      bump: 'none',
      base: boundary.base,
      commits: [],
      reason: `nothing since ${boundary.base} touched ${spec.paths.join(', ')}`,
    };
  }

  const bump = bumpFor(commits);
  return {
    key: spec.key,
    label: spec.label,
    release: true,
    version: nextVersion(boundary.base, bump),
    current,
    bump,
    base: boundary.base,
    commits: commits.map((c) => c.subject),
    reason: `${commits.length} commit(s) touched ${spec.paths.join(', ')}`,
  };
}

// ─── self-test ───────────────────────────────────────────────────────────────────────────────

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

  // Every package must be distinguishable, or two of them share a boundary and a tag.
  eq('package keys are unique', new Set(PACKAGES.map((p) => p.key)).size, PACKAGES.length);
  eq('tag prefixes are unique', new Set(PACKAGES.map((p) => p.tagPrefix)).size, PACKAGES.length);
  eq(
    'every package names a version file that exists',
    PACKAGES.filter((p) => !fs.existsSync(p.versionFile)).map((p) => p.key),
    [],
  );

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

// ─── entry ───────────────────────────────────────────────────────────────────────────────────

const RUN_DIRECTLY = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (RUN_DIRECTLY && process.argv.includes('--self-test')) {
  selfTest();
} else if (RUN_DIRECTLY) {
  const results = PACKAGES.map(resolve);
  const errors = results.filter((r) => r.error);
  if (errors.length > 0) {
    for (const e of errors) console.error(`✗ ${e.label}: ${e.error}`);
    process.exit(1);
  }
  const out = { any: results.some((r) => r.release), packages: results };
  if (process.argv.includes('--preview')) {
    for (const r of results) {
      console.log(`\n${r.label}`);
      console.log(`  in the repo    : ${r.current}`);
      console.log(`  last released  : ${r.base ?? '(never)'}`);
      console.log(`  bump           : ${r.bump}`);
      console.log(`  next version   : ${r.release ? r.version : '(no release)'}`);
      console.log(`  why            : ${r.reason}`);
      for (const c of r.commits) console.log(`    · ${c}`);
    }
    console.log(`\nRelease needed: ${out.any ? 'yes' : 'no'}\n`);
  } else {
    console.log(JSON.stringify(out));
  }
}
