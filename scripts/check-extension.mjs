#!/usr/bin/env node
// The extension has NO BUILD STEP, on purpose: the directory you read is the directory Chrome
// loads, which is most of why somebody can audit what they are about to hand control of their
// browser to. So "does it build" becomes two questions this answers.
//
//   1. Does the manifest name files that exist? A typo'd path is not an error anywhere — Chrome
//      just refuses to load the extension, or silently runs without that script.
//   2. Does every shipped module parse? A syntax error in a service worker is invisible until the
//      extension is installed and quietly does nothing.
//
// It lives in `scripts/` rather than inline in the workflow so `npm test` runs exactly what CI
// runs. That equivalence is the whole point — a lock file drifted once and every local lane stayed
// green while CI could not start, and inline steps are how that gap reopens.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'packages/extension';
let failed = 0;
const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  failed++;
};

// ── the manifest ─────────────────────────────────────────────────────────────────────────────
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
} catch (err) {
  console.error(`✗ manifest.json is not readable JSON: ${err.message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) fail(`manifest_version is ${manifest.manifest_version}, not 3`);
if (!/^\d+(\.\d+){1,3}$/.test(manifest.version ?? '')) {
  fail(`version ${JSON.stringify(manifest.version)} is not the dotted-integer form Chrome requires`);
}

const named = [
  manifest.action?.default_popup,
  manifest.background?.service_worker,
  ...Object.values(manifest.icons ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
  ...(manifest.web_accessible_resources ?? []).flatMap((r) => r.resources ?? []),
].filter(Boolean);

for (const rel of named) {
  if (!fs.existsSync(path.join(DIR, rel))) fail(`manifest names ${rel}, which does not exist`);
}
if (named.length === 0) fail('the manifest names no files at all — is it the right file?');

// ── every module parses ──────────────────────────────────────────────────────────────────────
function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const modules = jsFiles(DIR);
for (const file of modules) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    fail(`${file} does not parse:\n      ${String(err.stderr).split('\n')[2] ?? ''}`);
  }
}

// ── Every control the docs tell a reader to press has to exist ────────────────────────────────
//
// The README said: set Agent URL + Access Token, then press **Save & Connect**, and wait for the
// status *Connected to agent*. The button is labelled `Save` and the status reads `Connected` —
// neither quoted string has ever appeared in the extension. A reader following those instructions
// looks for a control that is not there and concludes the build is broken.
//
// Positive assertions, like the branding check in the fork: "the docs quote this, so the product
// must still say it". Rename a label deliberately and this fails, which is the point — it is the
// one place that knows the docs need the same edit.
const popupSrc = jsFiles(path.join(DIR, 'src', 'providers'))
  .map((f) => fs.readFileSync(f, "utf8"))
  .join('\n');

/** [what the docs call it, the literal the extension must still contain] */
const QUOTED_IN_DOCS = [
  ['the save button', '>Save<'],
  ['the add-profile button', '+ Add profile'],
  ['the URL field label', '>Agent URL<'],
  ['the token field label', '>Access Token<'],
  ['the connected status', 'Connected'],
];
for (const [what, literal] of QUOTED_IN_DOCS) {
  if (popupSrc.includes(literal)) continue;
  fail(`${what} — the docs quote ${JSON.stringify(literal)}, the popup no longer contains it.\n` +
       `      If you renamed it on purpose, update README.md and BRIDGE-SETUP.md in this commit.`);
}

if (failed > 0) {
  console.error(`\n✗ extension: ${failed} problem(s).`);
  process.exit(1);
}
console.log(
  `✅ extension: ${manifest.name} ${manifest.version} — MV3, ` +
    `${manifest.permissions.length} permissions, ${named.length} named files present, ` +
    `${modules.length} modules parse.`,
);
