import { createRequire } from "node:module";

/** Read from package.json at runtime rather than duplicated as a literal — one number to bump,
 *  and a build that forgets is impossible rather than merely unlikely. */
const pkg = createRequire(import.meta.url)("../package.json") as { version?: string };

export const RELAY_VERSION = pkg.version ?? "0.0.0";
