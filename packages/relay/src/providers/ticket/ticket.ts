// The ticket format: a short-lived HMAC-signed credential that says whose browser this is.
//
// THE POINT OF THE INDIRECTION. The extension signs in to whatever system owns the user's account
// and holds a credential for it. That credential is usually good for the WHOLE account: with it
// you can read their data, write it, act as them everywhere. If the extension sent it here, a
// relay compromise would become an ACCOUNT compromise for every connected person. So the extension
// never sends it. It asks the system that already handles account credentials, and gets back a
// ticket that does exactly one thing: open a socket. The relay holds no account credential at all.
//
// WHAT A TICKET DOES NOT CONTAIN, AND WHY. There is no workspace, team or project in here. A
// browser is a MACHINE, not a membership — one person's Chrome serves everything they belong to
// over ONE socket — and the relay is presence and dispatch, never authorization. Whether a given
// agent may drive a given browser right now is decided upstream, from live state, on every single
// call. Baking a membership list into a ten-minute ticket would add a check that can only ever be
// STALE, and stale in the wrong direction: someone added after the ticket was minted would be
// refused for something they genuinely belong to. A check that produces false refusals is worse
// than no check when the real check already runs upstream.
//
// 🚨 THE BYTES OF THIS FORMAT ARE A CONTRACT WITH A SECOND IMPLEMENTATION. Whoever mints has its
// own copy of this, and `scripts/crew/check-browser-ticket-parity.mjs` mints with one and verifies
// with the other. The claim KEYS (`v`, `u`, `b`, `exp`) are wire, not code: renaming `u` here
// would refuse every ticket on the fleet. Only the TypeScript names around them are ours to change.

import { createHmac, timingSafeEqual } from "node:crypto";
import { isValidIdComponent, type BrowserIdentity } from "../../identity.js";
import type { VerifyFailure, VerifyResult } from "../types.js";

/** Bumped only if the claim set changes shape. An unknown version is refused, never guessed at. */
export const TICKET_VERSION = 1;

/** How long a freshly minted ticket is good for. Long enough to survive a slow sign-in, short
 *  enough that a copied one is worthless by the time it is noticed. */
export const TICKET_TTL_MS = 10 * 60_000;

/** Claims, with short keys because this string is passed through a browser and stored in it.
 *  These four names are the wire format — see the file header. */
interface TicketClaims {
  v: number;
  /** Id of the person whose browser this is, in the minting system's own namespace. */
  u: string;
  /** Stable id the extension mints once per Chrome profile. */
  b: string;
  /** Expiry, epoch ms. */
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(key: string, payload: string): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

/**
 * Mint a ticket.
 *
 * Lives here rather than only in the minting system so the relay's own tests — and `relay ticket`
 * — can produce a valid one, and so the two halves of the format are impossible to drift apart
 * silently.
 *
 * It REFUSES an id containing the hub's separator, which the verifier also refuses. Both, because
 * a mint that can produce a credential its own verifier rejects is a bug that only ever surfaces
 * on somebody else's machine.
 */
export function mintRelayTicket(
  key: string,
  input: { ownerId: string; browserId: string; ttlMs?: number },
  now = Date.now()
): string {
  if (!key) throw new Error("mintRelayTicket: no signing key");
  if (!isValidIdComponent(input.ownerId)) {
    throw new Error(`mintRelayTicket: invalid ownerId ${JSON.stringify(input.ownerId)}`);
  }
  if (!isValidIdComponent(input.browserId)) {
    throw new Error(`mintRelayTicket: invalid browserId ${JSON.stringify(input.browserId)}`);
  }
  const claims: TicketClaims = {
    v: TICKET_VERSION,
    u: input.ownerId,
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
export function verifyRelayTicket(key: string, ticket: unknown, now = Date.now()): VerifyResult {
  const deny: VerifyFailure = { ok: false, reason: "unauthorized" };
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
  // Non-empty, bounded, and free of the hub's key separator. See identity.ts for why the separator
  // is the load-bearing half.
  if (!isValidIdComponent(claims.u)) return deny;
  if (!isValidIdComponent(claims.b)) return deny;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return deny;

  if (claims.exp <= now) return { ok: false, reason: "ticket_expired" };

  const identity: BrowserIdentity = {
    ownerId: claims.u,
    browserId: claims.b,
    expiresAt: claims.exp,
  };
  return { ok: true, identity };
}
