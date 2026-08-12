import { createRequire } from "node:module";

/** Read from package.json at runtime rather than duplicated as a literal — one number to bump,
 *  and a build that forgets is impossible rather than merely unlikely. */
const pkg = createRequire(import.meta.url)("../package.json") as {
  version?: string;
  bin?: Record<string, string>;
};

export const RELAY_VERSION = pkg.version ?? "0.0.0";

/**
 * What this build calls itself: the command name, the `service` field in `/health`, and the systemd
 * unit's `Description`.
 *
 * DERIVED FROM `bin`, not typed twice. A fork renames the binary in its package.json and every one
 * of those follows — which is the difference between rebranding being one edit and being a grep.
 * Falls back to a generic word rather than to ours, so a fork that removed `bin` does not
 * accidentally re-advertise this project's name.
 */
export const RELAY_NAME = Object.keys(pkg.bin ?? {})[0] ?? "relay";
