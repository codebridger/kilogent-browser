#!/usr/bin/env node
// Is package-lock.json in step with every workspace's package.json?
//
// WHY THIS EXISTS. `npm test` runs against the `node_modules` already on disk, so a lock file that
// has drifted is invisible locally — every lane green — while CI, which starts from `npm ci`, fails
// before running a single test. That is the "a laptop and CI disagree about what green means"
// failure, and it is worse than an ordinary red build because the local signal actively says the
// opposite.
//
// It happened here: the relay package was RENAMED after the last install, so the lock still carried
// a stale name for `packages/relay`. Eight test lanes passed; `npm ci` refused with
// "Missing: remote-browser-relay@0.2.0 from lock file".
//
// `npm ci --dry-run` would also catch it, and costs a network round trip and several seconds. This
// reads two files and answers the same question for the drift that actually happens: a workspace
// whose name or version moved without a reinstall.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

const lock = read("package-lock.json");
const pkg = read("package.json");
const problems = [];

if (lock.name !== pkg.name || lock.version !== pkg.version) {
  problems.push(`root: package.json is ${pkg.name}@${pkg.version}, lock says ${lock.name}@${lock.version}`);
}

/** Every directory matched by the `workspaces` globs — only the single trailing `*` form is used here. */
function workspaceDirs() {
  const out = [];
  for (const pattern of pkg.workspaces ?? []) {
    if (pattern.endsWith("/*")) {
      const base = pattern.slice(0, -2);
      const abs = path.join(root, base);
      if (!fs.existsSync(abs)) continue;
      for (const name of fs.readdirSync(abs)) {
        const rel = `${base}/${name}`;
        if (fs.existsSync(path.join(root, rel, "package.json"))) out.push(rel);
      }
    } else if (fs.existsSync(path.join(root, pattern, "package.json"))) {
      out.push(pattern);
    }
  }
  return out;
}

for (const rel of workspaceDirs()) {
  const wp = read(`${rel}/package.json`);
  const entry = lock.packages?.[rel];
  if (!entry) {
    problems.push(`${rel}: not in the lock file at all (${wp.name}@${wp.version})`);
    continue;
  }
  // `name` is omitted in the lock when it matches the directory; `version` is always written.
  const lockName = entry.name ?? path.basename(rel);
  if (lockName !== wp.name) {
    problems.push(`${rel}: package.json says ${wp.name}, lock says ${lockName}`);
  }
  if (entry.version !== wp.version) {
    problems.push(`${rel}: ${wp.name} is ${wp.version}, lock says ${entry.version}`);
  }
}

if (problems.length > 0) {
  console.error("✗ package-lock.json is out of step with the workspaces:");
  for (const p of problems) console.error(`    ${p}`);
  console.error("\n  `npm ci` will refuse this, so CI fails before any test runs.");
  console.error("  Fix: npm install     (then commit the lock file)");
  process.exit(1);
}
console.log(`✅ lock file agrees with the root and ${workspaceDirs().length} workspaces.`);
