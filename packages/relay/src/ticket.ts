// Relay tickets — how a browser proves whose it is without handing the relay a Firebase credential.
//
// THE POINT OF THE INDIRECTION. The extension signs in to Lumi and holds a Firebase ID token. That
// token is a credential for the whole Firebase project as that user: with it you can read their
// Ships, write their documents, act as them everywhere. If the extension sent it here, a relay
// compromise would become an ACCOUNT compromise for every connected person. So the extension never
// sends it. It calls a Crew callable, which authenticates the ID token in the one place that
// already handles Firebase credentials, and hands back a ticket that does exactly one thing: open
// a socket. The relay holds no Firebase credential at all and cannot talk to Firestore.
//
// WHAT A TICKET DOES NOT CONTAIN, AND WHY. There is no `shipId` in here. A browser is a MACHINE,
// not a membership — one person's Chrome serves every Ship they belong to over ONE socket — and
// the relay is presence and dispatch, never authorization. Whether a given agent may drive a given
// browser right now is decided by Crew, from live documents, on every single call. Baking a Ship
// list into a ten-minute ticket would add a check that can only ever be STALE, and stale in the
// wrong direction: a member added after the ticket was minted would be refused by the relay for a
// Ship they genuinely belong to. A check that produces false refusals is worse than no check when
// the real check already runs upstream.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Bumped only if the claim set changes shape. An unknown version is refused, never guessed at. */
export const TICKET_VERSION = 1;

const KEY_SEPARATOR = ":";

/** How long a freshly minted ticket is good for. Long enough to survive a slow sign-in, short
 *  enough that a copied one is worthless by the time it is noticed. */
export const TICKET_TTL_MS = 10 * 60_000;

/** Claims, with short keys because this string is passed through a browser and stored in it. */
interface TicketClaims {
  v: number;
  /** Firebase uid of the person whose browser this is. */
  u: string;
  /** Stable id the extension mints once per Chrome profile. */
  b: string;
  /** Expiry, epoch ms. */
  exp: number;
}

export interface TicketIdentity {
  ownerUid: string;
  browserId: string;
  /** Expiry of the ticket that opened this socket, epoch ms. */
  expiresAt: number;
}

export type TicketFailure =
  /** Not a ticket at all, or the signature does not match — indistinguishable on purpose. */
  | { ok: false; reason: "unauthorized" }
  /** Genuinely ours, genuinely too old. A SEPARATE outcome because the client's correct response
   *  differs: mint another and retry now, rather than back off and eventually give up. */
  | { ok: false; reason: "ticket_expired" };

export type TicketResult = { ok: true; identity: TicketIdentity } | TicketFailure;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(key: string, payload: string): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

/**
 * Mint a ticket. Lives here rather than only in Crew so the relay's own tests can produce a valid
 * one without importing Crew, and so the two halves of the format are impossible to drift apart —
 * Crew's `mintBrowserRelayTicket` is a port of this function and is checked against it by fixture.
 */
export function mintRelayTicket(
  key: string,
  input: { ownerUid: string; browserId: string; ttlMs?: number },
  now = Date.now()
): string {
  if (!key) throw new Error("mintRelayTicket: no signing key");
  const claims: TicketClaims = {
    v: TICKET_VERSION,
    u: input.ownerUid,
    b: input.browserId,
    exp: now + (input.ttlMs ?? TICKET_TTL_MS),
  };
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${payload}.${b64url(sign(key, payload))}`;
}

/**
 * Verify a ticket and return the identity it proves.
 *
 * Order matters: the SIGNATURE is checked before the expiry, so an unsigned string can never learn
 * that it merely looks expired. Only something we actually minted is ever told `ticket_expired`.
 */
export function verifyRelayTicket(key: string, ticket: unknown, now = Date.now()): TicketResult {
  const deny: TicketFailure = { ok: false, reason: "unauthorized" };
  if (!key) return deny;
  if (typeof ticket !== "string" || ticket.length === 0 || ticket.length > 4096) return deny;

  const dot = ticket.indexOf(".");
  if (dot <= 0 || dot === ticket.length - 1) return deny;
  const payload = ticket.slice(0, dot);
  const provided = ticket.slice(dot + 1);

  // Constant-time, and length-guarded first because timingSafeEqual THROWS on a length mismatch —
  // a throw here would be both a crash and a timing signal.
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(provided, "base64url");
  } catch {
    return deny;
  }
  const expected = sign(key, payload);
  if (providedBuf.length !== expected.length) return deny;
  if (!timingSafeEqual(providedBuf, expected)) return deny;

  let claims: TicketClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TicketClaims;
  } catch {
    return deny;
  }

  // Signed by us, but not a shape we understand. Refused rather than interpreted — a claim set we
  // cannot read is a claim set we cannot enforce.
  if (!claims || claims.v !== TICKET_VERSION) return deny;
  if (typeof claims.u !== "string" || !claims.u) return deny;
  if (typeof claims.b !== "string" || !claims.b) return deny;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return deny;

  // The hub key is `${uid}:${browserId}`, so a component containing the separator could name two
  // different browsers with one string. Firebase uids have no colons and a browserId is a UUID we
  // mint, so this is unreachable today — refused anyway, because "unreachable" is a property of
  // the code around it and "unrepresentable" is a property of the check itself.
  if (claims.u.includes(KEY_SEPARATOR) || claims.b.includes(KEY_SEPARATOR)) return deny;

  if (claims.exp <= now) return { ok: false, reason: "ticket_expired" };

  return { ok: true, identity: { ownerUid: claims.u, browserId: claims.b, expiresAt: claims.exp } };
}

/** The hub's map key. Ship-agnostic on purpose — see the file header. */
export function browserKey(ownerUid: string, browserId: string): string {
  return `${ownerUid}${KEY_SEPARATOR}${browserId}`;
}
