// Where the Kilogent mode talks to, and the one thing that is compiled in rather than discovered.
//
// The extension ships knowing ONE url: Crew's callable endpoint. Everything else it needs —
// the Firebase apiKey, the project id, the relay's WebSocket address — arrives at runtime, from
// the approval and from `mintBrowserRelayTicket`. That is deliberate: moving the relay, or
// pointing a build at a different project, then costs a redeploy on our side rather than an
// update pushed to every browser that ever installed this.
//
// It is a PUBLIC url. Nothing here is a secret, and nothing here grants anything: the endpoint
// refuses every call that is not signed in, and the only unauthenticated ones are the two halves
// of a device handshake that is worthless until a human approves it.

import { BUILD_ENV } from "../../build-env.js";

/** The DEVELOPMENT project's functions — what a checkout talks to, and the "dev" build's stamp. */
export const DEV_FUNCTIONS_BASE = "https://us-central1-lumi-afb7d.cloudfunctions.net";

/**
 * The environment this build is wired to.
 *
 * TWO BUILDS SHIP FROM THIS TREE (since 2026-09-21), declared under `extensionVariants` in the
 * root package.json: "Kilogent Browser (Dev)" talks to the development project, "Kilogent Browser"
 * to production (europe-west1). The release stamps each build's `functionsBase` into
 * `src/build-env.js`. A CHECKOUT carries no stamp, so loading this directory unpacked talks to
 * DEVELOPMENT — never to production, which is the direction a mistake should fall.
 *
 * ⚠️ The difference is invisible from inside the extension — every screen looks identical whichever
 * backend answers. This constant once said "Production" for months while naming a dev project id,
 * which is the kind of comment that survives precisely because nobody can contradict it by using
 * the software. So the popup names a non-production build out loud (`BUILD_LABEL`), and
 * `check-branding.mjs` pins every endpoint so a repoint fails there first.
 *
 * If you fork this, replace both endpoints with your own deployment's — in package.json's
 * `extensionVariants` and in `DEV_FUNCTIONS_BASE` above. See MAINTAINING.md §3, item 5: it is the one
 * item in the rebrand inventory that is a decision rather than a find-and-replace.
 */
export const DEFAULT_FUNCTIONS_BASE =
  typeof BUILD_ENV.functionsBase === "string" && BUILD_ENV.functionsBase
    ? BUILD_ENV.functionsBase
    : DEV_FUNCTIONS_BASE;

/**
 * What the popup calls this build — "Dev" — or null for production.
 *
 * A stamped build says so itself (`env.label`); a stamped build that names no label is production.
 * A checkout is DEVELOPMENT (see above), so it says "Dev" too.
 */
export const BUILD_LABEL =
  typeof BUILD_ENV.label === "string"
    ? BUILD_ENV.label || null
    : BUILD_ENV.functionsBase
      ? null
      : "Dev";

/**
 * The endpoint this install should use.
 *
 * AN ESCAPE HATCH, NOT THE ENVIRONMENT STORY. The two published builds are how a person chooses
 * development or production; this per-install string is for everything else — a Firebase emulator
 * on a contributor's laptop, a staging deployment — without publishing a third build.
 *
 * It is NOT a user-facing setting. A person who can be talked into changing where their browser
 * signs in has been phished, so it lives behind the same Advanced disclosure as the self-hosted
 * bridge and is never shown in the ordinary flow. That is a deliberate trade: an operator moving
 * their own install between environments types it once, and everybody else never sees it.
 *
 * ⚠️ Switching endpoints does NOT re-key storage. The session, browserId and ship list under
 * `KEYS` are shared across whatever this points at, so a browser moved between backends carries a
 * session the new one will reject — sign out first, or expect one confusing failure.
 */
export function resolveEndpoint(stored) {
  const raw = typeof stored === "string" ? stored.trim() : "";
  if (!raw) return DEFAULT_FUNCTIONS_BASE;
  return raw.replace(/\/+$/, "");
}

/** Storage keys. Namespaced so the pre-Kilogent bridge profiles can coexist untouched. */
export const KEYS = {
  session: "kilogent.session",
  browserId: "kilogent.browserId",
  /**
   * The workspaces an older version offered this browser to. NO LONGER WRITTEN — the browser
   * belongs to the account now (PRFAQ-001) — and removed on sight. Kept here only so sign-out and
   * the upgrade path can clear it.
   */
  ships: "kilogent.ships",
  /**
   * The browser's NAME as last typed or accepted here. The storage key says `label` because that
   * is what older versions called it, and keeping the key is what lets an update prefill the
   * naming step with the name the person already chose.
   */
  label: "kilogent.label",
  /**
   * The server's last word on this browser's record: `{uid, browserId, endpoint, name,
   * needsRename}`, refreshed by every heartbeat. Only a CACHE — the heartbeat's `registered` is the
   * truth — used so that a network blip does not drop a working socket.
   */
  registered: "kilogent.registered",
  /**
   * PAUSE ALL AGENTS, as a local switch. LOCAL FIRST, and kept across sign-out, on purpose: it has
   * to work when Kilogent is not open, not reachable, or not answering — so while it is on, this
   * extension refuses every relay command itself, whatever the server believes. The server is told
   * too, and re-told on every reconcile until it agrees.
   */
  paused: "kilogent.paused",
  /** A pause change the server has not acknowledged yet. Retried on every reconcile. */
  pauseDirty: "kilogent.pauseDirty",
  /** Where "My browsers" lives — the Kilogent web app's origin, learned from the sign-in page. */
  appOrigin: "kilogent.appOrigin",
  endpoint: "kilogent.endpoint",
  blocklist: "kilogent.blocklist",
  /**
   * Per-session Ship blocklists, `{[sessionId]: origins[]}`.
   *
   * PERSISTED because the worker is not. A blocklist that lives only in memory is gone at the next
   * MV3 eviction — and the relay does not re-send `session_open`, because ITS session is still open.
   * The extension then had no list, treated that as "nothing is blocked", and allowed everything.
   */
  sessions: "kilogent.sessions",
  /**
   * Per-session ALLOW lists, `{[sessionId]: origins[]}` — the sites a link names. Persisted for
   * the same reason as `sessions`. A session with no entry here has no allow list (any site except
   * the blocklist); whether the session is KNOWN at all is decided by `sessions` alone.
   */
  sessionAllows: "kilogent.sessionAllows",
  /**
   * An in-flight device handshake: `{userCode, deviceCode, expiresAt, label, endpoint}`.
   *
   * IN STORAGE RATHER THAN IN MEMORY, and that is the whole reason sign-in works. The service
   * worker owns the polling loop — the popup cannot, because Chrome destroys it the instant the
   * approval tab takes focus — and a worker may be evicted at any point during a ten-minute human
   * round-trip. Nothing here is bearer material: the device code is worthless without the approval
   * it is waiting for, and the row is deleted the moment it is redeemed.
   */
  pending: "kilogent.pending",
  /** Bumped to wipe a schema that changed shape. See `migrateIfNeeded`. */
  schema: "kilogent.schema",
};

/** Current storage schema. A mismatch clears Kilogent's keys rather than trying to upgrade them. */
export const SCHEMA_VERSION = 1;

/** The path of the account-level "My browsers" page in the Kilogent web app. */
export const MY_BROWSERS_PATH = "/browsers";
