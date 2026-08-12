// Who a browser is, as far as this process is concerned — and the one rule every auth provider
// has to satisfy.
//
// This used to live in `ticket.ts`, which had it backwards: the hub's map key is not a property of
// the ticket format, it is a property of the HUB, and every provider that ever exists has to
// produce identities that fit it. Putting it here is what lets a second provider be written
// without reading the first one.
//
// WHAT KEYS A CONNECTION, and why both halves. `${ownerId}:${browserId}`. Keying on the owner
// alone breaks one person running two Chrome profiles — the second would evict the first, forever,
// in a reconnect loop neither of them can see. Keying on anything narrower than the machine breaks
// two colleagues sharing whatever that thing is. A browser is a MACHINE, and the same machine
// serves every purpose its owner has over one socket.

/** Separates the two halves of a hub key. Neither half may contain it — see `isValidIdComponent`. */
export const KEY_SEPARATOR = ":";

/** Longest an id component may be. Bounds the map key, and matches the control plane's own cap. */
export const MAX_ID_LENGTH = 200;

/**
 * What a verified credential proves.
 *
 * `expiresAt` is when the CREDENTIAL stops being valid, epoch ms, or 0 for "never". It is reported
 * back so an operator can see a socket living on a credential that is about to lapse; the relay
 * does not enforce it after the handshake, because a live socket being cut mid-click by a clock is
 * worse than one held open by a browser that will have to re-authenticate anyway on reconnect.
 */
export interface BrowserIdentity {
  ownerId: string;
  browserId: string;
  expiresAt: number;
}

/**
 * Is this string usable as half of a hub key?
 *
 * The separator check is the load-bearing one: a component containing a colon could name two
 * different browsers with one string. Every provider must apply this — a provider that returns
 * `{ownerId: "a:b", browserId: "c"}` and one that returns `{ownerId: "a", browserId: "b:c"}` would
 * be handed the same socket.
 *
 * The rule is about the SEPARATOR, not about any particular id scheme. (An earlier comment here
 * argued the check was unreachable "because Firebase uids have no colons", which was reasoning
 * about one caller rather than about the code: a provider nobody had written yet was always free
 * to mint anything at all.)
 */
export function isValidIdComponent(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !value.includes(KEY_SEPARATOR)
  );
}

/** The hub's map key. */
export function browserKey(ownerId: string, browserId: string): string {
  return `${ownerId}${KEY_SEPARATOR}${browserId}`;
}
