#!/usr/bin/env node
/**
 * Refuse to document an environment variable the code does not read, and refuse to omit one the
 * code refuses to start without.
 *
 * WHY THIS EXISTS. The runbook told you to start the bridge with `BRIDGE_WS_TOKEN=…`. No such
 * variable has ever existed — the server reads `BRIDGE_ACCESS_TOKEN` and calls `process.exit(1)`
 * without it. So the first command of the deployment guide could not work, for anybody, ever. It
 * was introduced by a rewrite that was otherwise an improvement, reviewed, and merged, because a
 * plausible name in a fenced code block is indistinguishable from a correct one.
 *
 * The mirror-image failure was in `.env.example` at the same time: it opens with "Copy this to .env
 * and fill in values", lists the two OPTIONAL port variables, and omitted `BRIDGE_MCP_TOKEN` — the
 * one whose absence is fatal. Following the template exactly produced a server that would not boot.
 *
 * Neither is a typo. Both are what happens when prose about configuration is maintained separately
 * from the configuration, which is why this is a test and not a convention.
 *
 * SCOPE IS DELIBERATELY NARROW: variables this project itself defines. `GEMINI_API_KEY` and `PATH`
 * are somebody else's namespace, and a guard that policed them would be wrong about vendor docs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Variables this project owns — the only ones it can be authoritative about. */
const OWNED = /^(BRIDGE_|RELAY_|REMOTE_BROWSER_|MCP_PORT$|WS_PORT$|SESSION_IDLE_MS$)/;

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

const isSource = (f) => /^(packages|scripts)\/.*\.(ts|js|mjs|cjs)$/.test(f) && !/\.test\.ts$/.test(f);
const isDoc = (f) => f.endsWith('.md') || f === '.env.example';

/** Every owned variable the code actually reads — `process.env.X` and the `env.X` parameter form. */
const readByCode = new Set();
/** Every owned variable whose absence stops the process, taken from the refusal message itself. */
const required = new Set();

for (const f of tracked.filter(isSource)) {
  const body = read(f);
  // Two access shapes, and missing the second is how this guard first reported five false
  // positives: the bridge writes `process.env.BRIDGE_MCP_TOKEN`, while the relay passes the name
  // as a STRING — `num(env, "RELAY_PORT", 8787)`. A property-access regex sees only the first and
  // declares every relay variable undocumented.
  for (const m of body.matchAll(/\benv(?:\.|\[["'])([A-Z][A-Z0-9_]*)/g)) {
    if (OWNED.test(m[1])) readByCode.add(m[1]);
  }
  for (const m of body.matchAll(/["'`]([A-Z][A-Z0-9_]{3,})["'`]/g)) {
    if (OWNED.test(m[1])) readByCode.add(m[1]);
  }
  // "FATAL: X is not set" / "X is not set." — the exact shape both servers already use to refuse.
  for (const m of body.matchAll(/\b([A-Z][A-Z0-9_]{3,}) is not set/g)) {
    if (OWNED.test(m[1])) required.add(m[1]);
  }
}

/** Where each owned variable is NAMED in prose, so a failure can point at the line. */
const namedInDocs = new Map();
for (const f of tracked.filter(isDoc)) {
  read(f).split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) {
      if (!OWNED.test(m[1])) continue;
      if (!namedInDocs.has(m[1])) namedInDocs.set(m[1], []);
      namedInDocs.get(m[1]).push(`${f}:${i + 1}`);
    }
  });
}

const envExample = read('.env.example');
let failures = 0;
const fail = (msg, detail) => { failures++; console.log(`  ✗ ${msg}`); if (detail) console.log(`      ${detail}`); };

console.log('environment variables:');

// 1. THE BUG THIS EXISTS FOR. A name in a doc that no code reads is a command that cannot work.
for (const [name, where] of [...namedInDocs].sort()) {
  if (readByCode.has(name)) continue;
  fail(`${name} is documented but no code reads it`, `named at ${where.slice(0, 3).join(', ')}`);
}

// 2. A variable the process refuses to start without has to appear where THAT program's operator
//    would look. The two servers are configured by different means and do not share a template:
//    the bridge is started by hand from a checkout, so `.env.example` is its front door; the relay
//    is an installed npm package that reads its own `relay.env` under REMOTE_BROWSER_RELAY_HOME,
//    so its README is. Pointing both at the root `.env.example` would demand the relay document
//    itself in a file its users never see.
const TEMPLATE = [
  [/^BRIDGE_/, '.env.example'],
  [/^RELAY_/, 'packages/relay/README.md'],
];
for (const name of [...required].sort()) {
  const row = TEMPLATE.find(([re]) => re.test(name));
  if (!row) continue;
  const [, file] = row;
  // An ASSIGNMENT, not a mention. `.env.example` explains the two tokens in its header comment, so
  // `includes(name)` stayed true after the `BRIDGE_MCP_TOKEN=` line was deleted — a mutation test
  // caught that, and it is the whole failure this check exists for.
  const present = file.endsWith('.env.example')
    ? new RegExp(`^${name}=`, 'm').test(read(file))
    : read(file).includes(name);
  if (present) continue;
  fail(`${name} is fatal-if-missing but absent from ${file}`,
       'that file is what its operator copies; omitting it hands them a process that will not boot');
}

if (failures === 0) {
  console.log(`  ✓ ${namedInDocs.size} documented variables all exist in code`);
  console.log(`  ✓ ${required.size} fatal-if-missing variables (${[...required].sort().join(', ')}) appear in their own operator's template`);
  console.log('\n✅ env parity');
  process.exit(0);
}
console.error(`\n❌ env parity: ${failures} problem(s). Docs and code disagree about configuration.`);
process.exit(1);
