import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { browserKey } from "../../identity.js";
import { mintRelayTicket, verifyRelayTicket, TICKET_TTL_MS } from "./ticket.js";

const KEY = "k".repeat(64);
const OTHER = "j".repeat(64);

/** Sign a claims object with the real key. The only way to test the verifier's own checks: a
 *  refusal by SIGNATURE would pass every one of them for the wrong reason. */
function signed(claims: Record<string, unknown>, key = KEY): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest().toString("base64url")}`;
}

describe("relay tickets", () => {
  it("round-trips the identity it was minted with", () => {
    const t = mintRelayTicket(KEY, { ownerId: "uid_navid", browserId: "brw_mac" }, 1_000);
    const v = verifyRelayTicket(KEY, t, 2_000);
    assert.equal(v.ok, true);
    assert.deepEqual(v.ok && v.identity, {
      ownerId: "uid_navid",
      browserId: "brw_mac",
      expiresAt: 1_000 + TICKET_TTL_MS,
    });
  });

  it("refuses a ticket signed with a different key", () => {
    const t = mintRelayTicket(OTHER, { ownerId: "u", browserId: "b" });
    assert.deepEqual(verifyRelayTicket(KEY, t), { ok: false, reason: "unauthorized" });
  });

  it("refuses a tampered payload", () => {
    // The whole point of the signature: swapping the owner must not survive it.
    const t = mintRelayTicket(KEY, { ownerId: "uid_navid", browserId: "b" });
    const [, sig] = t.split(".");
    const forged = Buffer.from(
      JSON.stringify({ v: 1, u: "uid_someone_else", b: "b", exp: Date.now() + 60_000 })
    ).toString("base64url");
    assert.deepEqual(verifyRelayTicket(KEY, `${forged}.${sig}`), {
      ok: false,
      reason: "unauthorized",
    });
  });

  it("tells an EXPIRED ticket apart from a bad one", () => {
    // Not cosmetic. The extension's correct response differs: re-mint and retry now, versus stop
    // and tell the human. An extension that backs off exponentially on an expired ticket is a
    // browser that silently stops working ten minutes after it was working fine.
    const t = mintRelayTicket(KEY, { ownerId: "u", browserId: "b", ttlMs: 1_000 }, 0);
    assert.equal(verifyRelayTicket(KEY, t, 999).ok, true);
    assert.deepEqual(verifyRelayTicket(KEY, t, 1_000), { ok: false, reason: "ticket_expired" });
    assert.deepEqual(verifyRelayTicket(KEY, t, 5_000), { ok: false, reason: "ticket_expired" });
  });

  it("never reveals expiry for something it did not sign", () => {
    // Signature before expiry, so a forged string learns nothing about the clock.
    const stale = Buffer.from(JSON.stringify({ v: 1, u: "u", b: "b", exp: 1 })).toString(
      "base64url"
    );
    assert.deepEqual(verifyRelayTicket(KEY, `${stale}.deadbeef`), {
      ok: false,
      reason: "unauthorized",
    });
  });

  it("refuses a version it does not understand, rather than guessing", () => {
    assert.deepEqual(verifyRelayTicket(KEY, signed({ v: 99, u: "u", b: "b", exp: 9e12 })), {
      ok: false,
      reason: "unauthorized",
    });
  });

  it("refuses an identity that could name two browsers with one key — at BOTH ends", () => {
    // `${ownerId}:${browserId}` is the hub key, so a colon inside either half is an ambiguity.
    // The MINT refuses it, so this relay can never hand out such a credential…
    assert.throws(() => mintRelayTicket(KEY, { ownerId: "a", browserId: "b:c" }), /browserId/);
    assert.throws(() => mintRelayTicket(KEY, { ownerId: "a:b", browserId: "c" }), /ownerId/);
    // …and the VERIFIER refuses it too, which is the half that matters: the ticket on the wire was
    // minted somewhere else, by an implementation this repo does not own.
    assert.deepEqual(verifyRelayTicket(KEY, signed({ v: 1, u: "a", b: "b:c", exp: 9e12 })), {
      ok: false,
      reason: "unauthorized",
    });
    assert.deepEqual(verifyRelayTicket(KEY, signed({ v: 1, u: "a:b", b: "c", exp: 9e12 })), {
      ok: false,
      reason: "unauthorized",
    });
  });

  it("refuses an id longer than the control plane would accept", () => {
    // Otherwise a browser could connect on a credential no dispatch could ever address, and the
    // symptom would be a browser that is online and unreachable.
    const long = "x".repeat(201);
    assert.throws(() => mintRelayTicket(KEY, { ownerId: long, browserId: "b" }), /ownerId/);
    assert.deepEqual(verifyRelayTicket(KEY, signed({ v: 1, u: long, b: "b", exp: 9e12 })), {
      ok: false,
      reason: "unauthorized",
    });
  });

  it("refuses garbage without throwing", () => {
    for (const bad of ["", ".", "a.", ".b", "no-dot", "x".repeat(5000), null, 42, {}, undefined]) {
      const v = verifyRelayTicket(KEY, bad as unknown);
      assert.equal(v.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
    }
  });

  it("refuses everything when the relay has no key configured", () => {
    const t = mintRelayTicket(KEY, { ownerId: "u", browserId: "b" });
    assert.deepEqual(verifyRelayTicket("", t), { ok: false, reason: "unauthorized" });
    assert.throws(() => mintRelayTicket("", { ownerId: "u", browserId: "b" }), /no signing key/);
  });

  it("builds the hub key from both halves", () => {
    assert.equal(browserKey("uid", "brw"), "uid:brw");
  });
});
