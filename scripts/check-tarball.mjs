#!/usr/bin/env node
// Install the relay's REAL tarball outside the repo and run its REAL binary by name.
//
// The one thing no unit test covers: that the ARTIFACT works. Every test runs `dist/` by path, so
// they stay green through a broken `bin` mapping, a file missing from `files`, or a dependency that
// only resolves because it happens to sit in the repo's node_modules.

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-tarball-'));

try {
  const tarball = run(`npm pack --silent --pack-destination "${tmp}"`, 'packages/relay');
  console.log(`  packed ${tarball}`);

  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'smoke', private: true }));
  run(`npm i --no-audit --no-fund "${path.join(tmp, tarball)}"`, tmp);

  const bin = path.join(tmp, 'node_modules', '.bin', 'remote-browser-relay');
  if (!fs.existsSync(bin)) {
    console.error(`✗ the tarball installed, but no \`remote-browser-relay\` binary appeared.`);
    console.error('  That is a broken `bin` mapping — every other test passes straight through it.');
    process.exit(1);
  }

  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  const expected = JSON.parse(fs.readFileSync('packages/relay/package.json', 'utf8')).version;
  if (version !== expected) {
    console.error(`✗ the installed binary reports ${version}, package.json says ${expected}.`);
    process.exit(1);
  }
  // `--help` exercises the whole command tree; a module that fails to import shows up here and
  // nowhere else, because `--version` is answered before most of the CLI is touched.
  const help = execFileSync(bin, ['--help'], { encoding: 'utf8' });
  for (const cmd of ['start', 'setup', 'ticket', 'doctor', 'service']) {
    if (!help.includes(cmd)) {
      console.error(`✗ \`${cmd}\` is missing from the installed CLI's help.`);
      process.exit(1);
    }
  }
  console.log(`✅ tarball: remote-browser-relay@${version} installs and runs by name.`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
