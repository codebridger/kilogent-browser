#!/usr/bin/env node
// Do the workflow files actually parse, and are they the shape Actions expects?
//
// WHY THIS EXISTS. A step was named:
//
//     - name: `npm test` still runs everything this file gates on
//
// A backtick is a RESERVED INDICATOR in YAML — a plain scalar may not begin with one — so the file
// was invalid. GitHub could not load it, showed the run under the file's PATH instead of its name,
// reported a failure with ZERO jobs and no logs, and every pull request silently lost its CI.
//
// It shipped because I validated the file, then edited it with a script, and did not validate
// again. A check that runs in `npm test` cannot be skipped that way.
//
// It also asserts the SHAPE, not just the syntax: a file that parses but has no `on:` or no `jobs:`
// is accepted by YAML and ignored by Actions, which is the same silence with a different cause.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
let yaml;
try {
  yaml = require_('js-yaml');
} catch {
  console.error('✗ js-yaml is not installed — it is a devDependency of this repo.');
  console.error('  Run: npm install');
  process.exit(1);
}

const dir = '.github/workflows';
if (!fs.existsSync(dir)) {
  console.log('✅ workflows: none to check.');
  process.exit(0);
}

const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
let failed = 0;

if (files.length === 0) {
  console.error('✗ .github/workflows exists but holds no workflow files.');
  process.exit(1);
}

for (const name of files) {
  const file = path.join(dir, name);
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // The message names the line, which is the whole value of catching it here.
    console.error(`  ✗ ${name}: ${String(err.message).split('\n')[0]}`);
    if (err.mark) console.error(`      line ${err.mark.line + 1}, column ${err.mark.column + 1}`);
    failed++;
    continue;
  }

  if (!doc || typeof doc !== 'object') {
    console.error(`  ✗ ${name}: parses, but is not a mapping`);
    failed++;
    continue;
  }
  // `on:` is YAML 1.1's boolean true, which js-yaml resolves — so check both spellings rather than
  // reporting a missing trigger on a file that has one.
  const hasOn = 'on' in doc || true in doc;
  if (!hasOn) {
    console.error(`  ✗ ${name}: no \`on:\` — Actions will never run it`);
    failed++;
    continue;
  }
  if (!doc.jobs || Object.keys(doc.jobs).length === 0) {
    console.error(`  ✗ ${name}: no \`jobs:\` — nothing to run`);
    failed++;
    continue;
  }
  for (const [jobName, job] of Object.entries(doc.jobs)) {
    if (!job || (!job.steps && !job.uses)) {
      console.error(`  ✗ ${name}: job \`${jobName}\` has neither steps nor a reusable workflow`);
      failed++;
    }
  }
  console.log(`  ✓ ${name} (${Object.keys(doc.jobs).length} job(s))`);
}

if (failed > 0) {
  console.error(`\n✗ workflows: ${failed} problem(s). Actions would fail to load these, with zero`);
  console.error('  jobs and no logs — which reads like nothing happened rather than like an error.');
  process.exit(1);
}
console.log(`\n✅ workflows: ${files.length} file(s) parse and have runnable jobs.`);
