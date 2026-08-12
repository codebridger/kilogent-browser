#!/usr/bin/env node
/**
 * Assert this fork's user-visible identity survived the last merge from upstream.
 *
 * WHY THIS EXISTS, precisely. Merging upstream means resolving conflicts in files that are MOSTLY
 * upstream's and PARTLY ours — `popup.html` above all, where the structure is theirs and only a few
 * strings are ours. The natural resolution is "take theirs, re-apply our bits", and the failure mode
 * is re-applying only the bits you remembered. That happened: the 2026-08-12 merge took upstream's
 * popup and restored the `<h1>` but not the `.sub`, so the extension shipped with our name over
 * upstream's self-hosted-bridge copy — "Each profile is a bridge connection… Toggle one on to
 * connect" — describing a UI this build does not have.
 *
 * Every test in the suite passed. They had to: the branding is not behaviour, so the harness, the
 * registry test and the popup test were all still green. Only a human opening the popup could see
 * it, and that is the one thing CI cannot do.
 *
 * MAINTAINING.md's conflict table had ALSO said "only the heading and the stylesheet are ours",
 * disagreeing with its own rebrand table six sections down. So the doc a merge consults was wrong,
 * which is why this is a TEST and not a third sentence in that doc.
 *
 * THE ASSERTIONS ARE POSITIVE, not a blocklist of upstream's phrases. Upstream is free to rewrite
 * its own copy whenever it likes, so "does not contain their words" would rot; "still contains
 * ours" cannot. If you deliberately change one of these strings, change it here in the same commit —
 * that is the point, not an inconvenience.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

/**
 * `imports: false` means: this string must appear somewhere OTHER than an import line.
 *
 * The first version of this file checked `body.includes("createKilogentTransport")`, which is
 * VACUOUS for a registration — the identifier is on the import line too, so deleting it from the
 * TRANSPORTS array left the check green. A mutation test caught it. What matters is that the factory
 * is USED, not that it is imported, so those two rows strip the imports before looking.
 */
/** [file, human description, the exact string that must still be present, {imports?}] */
const MUST_CONTAIN = [
  // The two lines the merge got half-right. Both are ours; both are adjacent to upstream's markup.
  [
    'packages/extension/popup.html',
    'the popup heading',
    '<h1>Kilogent Browser</h1>',
  ],
  [
    'packages/extension/popup.html',
    'the popup sub-heading (THE ONE A MERGE ATE — see the file header)',
    'Lend this Chrome to your workspace.',
  ],

  // The manifest is what Chrome shows in the extensions list and the toolbar tooltip.
  ['packages/extension/manifest.json', 'the extension name', '"name": "Kilogent Browser"'],
  ['packages/extension/manifest.json', 'the toolbar tooltip', '"default_title": "Kilogent Browser"'],
  ['packages/extension/manifest.json', 'the store description', 'Lend this Chrome to your Kilogent workspace'],

  // The two registration lines. Losing either leaves a build that looks right and connects to
  // nothing — `providers/index.js` and `panels.js` are upstream files we add exactly one line to.
  [
    'packages/extension/src/providers/index.js',
    'the Kilogent transport registration (not merely the import)',
    'createKilogentTransport',
    { imports: false },
  ],
  [
    'packages/extension/src/providers/panels.js',
    'the Kilogent panel registration (not merely the import)',
    'createKilogentPanel',
    { imports: false },
  ],

  // The endpoint. A fork with our branding pointing at nothing is worse than an unbranded build,
  // because it looks installed and working.
  [
    'packages/extension/src/providers/kilogent/config.js',
    'the backend endpoint',
    'us-central1-lumi-afb7d.cloudfunctions.net',
  ],
];

let failed = 0;
for (const [file, what, needle, opts = {}] of MUST_CONTAIN) {
  let body;
  try {
    body = read(file);
    // Drop import lines, so "is it registered" cannot be satisfied by "is it imported".
    if (opts.imports === false) {
      body = body
        .split('\n')
        .filter((line) => !/^\s*import\b/.test(line))
        .join('\n');
    }
  } catch (err) {
    console.log(`  ✗ ${file} — cannot read: ${err.message}`);
    failed++;
    continue;
  }
  if (body.includes(needle)) {
    console.log(`  ✓ ${what}`);
  } else {
    failed++;
    console.log(`  ✗ ${what}`);
    console.log(`      ${file} no longer contains: ${JSON.stringify(needle)}`);
    console.log(`      If a merge from upstream overwrote it, restore it. If you changed it on`);
    console.log(`      purpose, update scripts/check-branding.mjs in the same commit.`);
  }
}

if (failed > 0) {
  console.error(`\n❌ branding: ${failed}/${MUST_CONTAIN.length} of this fork's own strings are missing.`);
  process.exit(1);
}
console.log(`\n✅ branding: ${MUST_CONTAIN.length} fork-owned strings survived.`);
