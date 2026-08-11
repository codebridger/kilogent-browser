// Which transports this build has — one door, and the place a fork adds its own.
//
// HOW TO ADD ONE. Write `providers/<yours>/index.js` exporting a factory that returns a Transport
// (see `registry.js` for the shape), then add one line to `TRANSPORTS` below. Nothing else in the
// extension changes: `sw.js` never learns your transport exists, so it stays byte-identical to
// upstream's and `git merge upstream/main` stays clean forever.
//
// A fork that finds itself editing `sw.js`, `executor.js`, `page-scripts.js` or `connection.js`
// has taken a wrong turn — those are core, and every line changed there is a line to re-merge by
// hand for as long as the fork exists. If the seam genuinely will not stretch far enough, that is
// worth an upstream issue rather than a local edit; the seam is young and it is meant to move.

import { createBridgeTransport } from "./bridge/index.js";
import { createLumiTransport } from "./lumi/index.js";

/**
 * Factories, not instances, so nothing connects at import time — the worker decides when.
 * @type {Array<(deps: any) => import("./registry.js").Transport>}
 */
export const TRANSPORTS = [createBridgeTransport, createLumiTransport];
