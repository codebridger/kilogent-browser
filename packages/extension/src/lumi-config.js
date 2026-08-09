// Where the Lumi mode talks to, and the one thing that is compiled in rather than discovered.
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

/** Production. Overridable per install for development — see `resolveEndpoint`. */
export const DEFAULT_FUNCTIONS_BASE = "https://us-central1-lumi-afb7d.cloudfunctions.net";

/**
 * The endpoint this install should use.
 *
 * An override exists for one reason: this repo is open source and its own dev loop points at a
 * Firebase emulator. It is NOT a user-facing setting — a person who can be talked into changing
 * where their browser signs in has been phished, so it lives behind the same Advanced disclosure
 * as the self-hosted bridge and is never shown in the ordinary flow.
 */
export function resolveEndpoint(stored) {
  const raw = typeof stored === "string" ? stored.trim() : "";
  if (!raw) return DEFAULT_FUNCTIONS_BASE;
  return raw.replace(/\/+$/, "");
}

/** Storage keys. Namespaced so the pre-Lumi bridge profiles can coexist untouched. */
export const KEYS = {
  session: "lumi.session",
  browserId: "lumi.browserId",
  ships: "lumi.ships",
  label: "lumi.label",
  endpoint: "lumi.endpoint",
  blocklist: "lumi.blocklist",
  /**
   * An in-flight device handshake: `{userCode, deviceCode, expiresAt, label, endpoint}`.
   *
   * IN STORAGE RATHER THAN IN MEMORY, and that is the whole reason sign-in works. The service
   * worker owns the polling loop — the popup cannot, because Chrome destroys it the instant the
   * approval tab takes focus — and a worker may be evicted at any point during a ten-minute human
   * round-trip. Nothing here is bearer material: the device code is worthless without the approval
   * it is waiting for, and the row is deleted the moment it is redeemed.
   */
  pending: "lumi.pending",
  /** Bumped to wipe a schema that changed shape. See `migrateIfNeeded`. */
  schema: "lumi.schema",
};

/** Current storage schema. A mismatch clears Lumi's keys rather than trying to upgrade them. */
export const SCHEMA_VERSION = 1;
