// Where the relay keeps its state.
//
// This file used to be much longer, because the package had been renamed and `configDir()` read the
// old directory when the new one was absent. That compatibility path is gone — no installed box is
// on the old name any more — so what is left is the rule itself: one directory, one override, and
// the override wins.

import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir, envFile, DIR_NAME } from "./paths.js";

let home: string;
let next: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-paths-"));
  next = path.join(home, DIR_NAME);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  delete process.env.REMOTE_BROWSER_RELAY_HOME;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.REMOTE_BROWSER_RELAY_HOME;
});

describe("where the relay keeps its state", () => {
  it("is one directory under the home directory", () => {
    expect(configDir()).toBe(next);
  });

  it("does not depend on the directory already existing", () => {
    // `setup` creates it. Resolving the path must not require it, or the first run has nowhere to
    // write the file it is about to create.
    expect(fs.existsSync(next)).toBe(false);
    expect(configDir()).toBe(next);
  });

  it("an explicit home beats it", () => {
    process.env.REMOTE_BROWSER_RELAY_HOME = "/tmp/explicit";
    expect(configDir()).toBe("/tmp/explicit");
  });

  it("the env file lives inside whichever home won", () => {
    expect(envFile()).toBe(path.join(next, "relay.env"));
    process.env.REMOTE_BROWSER_RELAY_HOME = "/tmp/explicit";
    expect(envFile()).toBe(path.join("/tmp/explicit", "relay.env"));
  });
});
