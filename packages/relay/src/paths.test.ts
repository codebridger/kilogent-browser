// The config-directory migration, which runs exactly once on somebody's live box.
//
// The package was renamed, so `~/.lumi-relay/` became `~/.remote-browser-relay/`. An installed
// relay must keep working across that with nothing done by hand, and must not end up with two
// directories holding the same two long-lived keys — that is the state where somebody edits the
// wrong one and cannot see why nothing changed.

import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configDir,
  legacyConfigDir,
  migrateLegacyConfigDir,
  DIR_NAME,
  LEGACY_DIR_NAME,
} from "./paths.js";

let home: string;
let legacy: string;
let next: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-paths-"));
  legacy = path.join(home, LEGACY_DIR_NAME);
  next = path.join(home, DIR_NAME);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  delete process.env.REMOTE_BROWSER_RELAY_HOME;
  delete process.env.LUMI_RELAY_HOME;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.REMOTE_BROWSER_RELAY_HOME;
  delete process.env.LUMI_RELAY_HOME;
});

/** A box installed before the rename. */
function oldBox() {
  fs.mkdirSync(legacy, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(legacy, "relay.env"), "RELAY_PORT=8787\n");
}

describe("where the relay keeps its state", () => {
  it("uses the new directory on a fresh box", () => {
    expect(configDir()).toBe(next);
    expect(legacyConfigDir()).toBeNull();
  });

  it("STILL FINDS the config on a box that predates the rename", () => {
    // The property that makes the rename safe to ship: an installed relay keeps running on its
    // existing configuration, before anybody migrates anything.
    oldBox();
    expect(configDir()).toBe(legacy);
    expect(legacyConfigDir()).toBe(legacy);
  });

  it("moves it, and the old one is GONE rather than copied", () => {
    oldBox();
    const moved = migrateLegacyConfigDir();
    expect(moved.moved).toBe(true);
    expect(fs.readFileSync(path.join(next, "relay.env"), "utf8")).toContain("RELAY_PORT=8787");
    expect(fs.existsSync(legacy)).toBe(false);
    expect(configDir()).toBe(next);
  });

  it("migrating twice is a no-op, not a second move", () => {
    oldBox();
    migrateLegacyConfigDir();
    expect(migrateLegacyConfigDir().moved).toBe(false);
  });

  it("with BOTH present the new one wins, and it refuses to merge", () => {
    // A half-finished migration, or somebody who made the directory by hand. Preferring the old
    // one here would silently strand every write the new one had already taken; merging two
    // configurations would be a guess about which key is current.
    fs.mkdirSync(next, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    expect(configDir()).toBe(next);
    expect(legacyConfigDir()).toBeNull();
    expect(migrateLegacyConfigDir().moved).toBe(false);
  });

  it("an explicit home beats both, under either variable name", () => {
    oldBox();
    process.env.REMOTE_BROWSER_RELAY_HOME = "/tmp/explicit";
    expect(configDir()).toBe("/tmp/explicit");
    expect(legacyConfigDir()).toBeNull(); // nothing to migrate when the home was named

    delete process.env.REMOTE_BROWSER_RELAY_HOME;
    process.env.LUMI_RELAY_HOME = "/tmp/old-explicit";
    expect(configDir()).toBe("/tmp/old-explicit");
  });

  it("the new variable wins when both are set", () => {
    process.env.REMOTE_BROWSER_RELAY_HOME = "/tmp/new";
    process.env.LUMI_RELAY_HOME = "/tmp/old";
    expect(configDir()).toBe("/tmp/new");
  });
});
