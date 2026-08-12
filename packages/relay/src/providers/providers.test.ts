import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { resolveAuthProvider, DEFAULT_AUTH } from "./index.js";
import { parseTokenList } from "./token/index.js";
import { mintRelayTicket } from "./ticket/ticket.js";

const CONTROL = "c".repeat(64);
const TICKET = "t".repeat(64);
const SECRET = "s".repeat(32);

describe("provider registry", () => {
  it("defaults to ticket, so a deployment that never heard of RELAY_AUTH keeps working", () => {
    // The one property that makes this change safe to deploy: an existing relay.env has no
    // RELAY_AUTH line, and must behave exactly as it did.
    assert.equal(DEFAULT_AUTH, "ticket");
    const p = resolveAuthProvider({ RELAY_CONTROL_KEY: CONTROL, RELAY_TICKET_KEY: TICKET });
    assert.equal(p.name, "ticket");
  });

  it("names what it has when asked for something it does not", () => {
    assert.throws(
      () => resolveAuthProvider({ RELAY_AUTH: "oauth", RELAY_CONTROL_KEY: CONTROL }),
      /ticket, token/
    );
  });

  it("never prints a secret in the line it puts in the log", () => {
    const ticket = resolveAuthProvider({ RELAY_CONTROL_KEY: CONTROL, RELAY_TICKET_KEY: TICKET });
    const token = resolveAuthProvider({
      RELAY_AUTH: "token",
      RELAY_CONTROL_KEY: CONTROL,
      RELAY_TOKENS: `laptop=${SECRET}`,
    });
    for (const p of [ticket, token]) {
      assert.equal(p.describe().includes(TICKET), false, `${p.name} leaked the ticket key`);
      assert.equal(p.describe().includes(CONTROL), false, `${p.name} leaked the control key`);
      assert.equal(p.describe().includes(SECRET), false, `${p.name} leaked a browser token`);
    }
  });
});

describe("ticket provider", () => {
  const env = { RELAY_CONTROL_KEY: CONTROL, RELAY_TICKET_KEY: TICKET };

  it("verifies a ticket it minted", () => {
    const p = resolveAuthProvider(env);
    const v = p.verifyBrowser(p.mint!({ ownerId: "u1", browserId: "b1" }, 1_000), 2_000);
    assert.equal(v.ok, true);
    assert.equal(v.ok && v.identity.ownerId, "u1");
  });

  it("gates the control plane on the control key, NOT on the ticket key", () => {
    const p = resolveAuthProvider(env);
    assert.equal(p.verifyDispatch(CONTROL), true);
    assert.equal(p.verifyDispatch(TICKET), false);
    assert.equal(p.verifyDispatch(null), false);
    assert.equal(p.verifyDispatch(""), false);
  });

  it("refuses one secret doing both jobs", () => {
    assert.throws(
      () => resolveAuthProvider({ RELAY_CONTROL_KEY: CONTROL, RELAY_TICKET_KEY: CONTROL }),
      /same value/
    );
  });

  it("refuses a missing or short ticket key, and names the fix", () => {
    assert.throws(() => resolveAuthProvider({ RELAY_CONTROL_KEY: CONTROL }), /openssl rand/);
    assert.throws(
      () => resolveAuthProvider({ RELAY_CONTROL_KEY: CONTROL, RELAY_TICKET_KEY: "short" }),
      /at least 32 characters/
    );
  });
});

describe("token provider", () => {
  const env = {
    RELAY_AUTH: "token",
    RELAY_CONTROL_KEY: CONTROL,
    RELAY_TOKENS: `laptop=${"a".repeat(32)}, desktop=${"b".repeat(32)}`,
  };

  it("gives each machine its own browserId, so two profiles do not evict each other", () => {
    // The whole reason this is a list rather than one token: a shared name is a shared hub key,
    // and the second connection would supersede the first forever.
    const p = resolveAuthProvider(env);
    const a = p.verifyBrowser("a".repeat(32));
    const b = p.verifyBrowser("b".repeat(32));
    assert.equal(a.ok && a.identity.browserId, "laptop");
    assert.equal(b.ok && b.identity.browserId, "desktop");
    assert.equal(a.ok && a.identity.ownerId, "local");
  });

  it("says never rather than pretending to expire", () => {
    const v = resolveAuthProvider(env).verifyBrowser("a".repeat(32));
    assert.equal(v.ok && v.identity.expiresAt, 0);
  });

  it("refuses an unknown token, and refuses a non-string without throwing", () => {
    const p = resolveAuthProvider(env);
    assert.deepEqual(p.verifyBrowser("z".repeat(32)), { ok: false, reason: "unauthorized" });
    for (const bad of [null, undefined, 42, {}, ""]) {
      assert.equal(p.verifyBrowser(bad as unknown).ok, false);
    }
  });

  it("has no mint, and says so by being absent rather than by returning something useless", () => {
    assert.equal(resolveAuthProvider(env).mint, undefined);
  });

  it("refuses a browser token that is also the control key", () => {
    // Otherwise a machine holding its own credential could dispatch to every sibling.
    assert.throws(
      () =>
        resolveAuthProvider({
          RELAY_AUTH: "token",
          RELAY_CONTROL_KEY: CONTROL,
          RELAY_TOKENS: `laptop=${CONTROL}`,
        }),
      /same value as the token/
    );
  });

  it("refuses a configuration in which no browser could ever connect", () => {
    assert.throws(
      () => resolveAuthProvider({ RELAY_AUTH: "token", RELAY_CONTROL_KEY: CONTROL }),
      /neither RELAY_TOKEN nor RELAY_TOKENS/
    );
  });

  it("accepts the single-token shorthand, and refuses it colliding with the list", () => {
    const p = resolveAuthProvider({
      RELAY_AUTH: "token",
      RELAY_CONTROL_KEY: CONTROL,
      RELAY_TOKEN: SECRET,
    });
    const v = p.verifyBrowser(SECRET);
    assert.equal(v.ok && v.identity.browserId, "browser");
    assert.throws(
      () =>
        resolveAuthProvider({
          RELAY_AUTH: "token",
          RELAY_CONTROL_KEY: CONTROL,
          RELAY_TOKEN: SECRET,
          RELAY_TOKENS: `browser=${"q".repeat(32)}`,
        }),
      /both set/
    );
  });
});

describe("token list parsing", () => {
  it("ignores surrounding whitespace and empty entries", () => {
    const m = parseTokenList(` laptop = ${"a".repeat(32)} , , desktop=${"b".repeat(32)} `);
    assert.deepEqual([...m.keys()], ["laptop", "desktop"]);
  });

  it("refuses a name that would break the hub key", () => {
    assert.throws(() => parseTokenList(`a:b=${"a".repeat(32)}`), /usable browser name/);
  });

  it("refuses a duplicate name rather than silently keeping one", () => {
    assert.throws(() => parseTokenList(`a=${"1".repeat(32)},a=${"2".repeat(32)}`), /appears twice/);
  });

  it("refuses a duplicate SECRET, which is the one that fails silently", () => {
    // Two names sharing a secret both resolve to one entry, so the machines share a hub key and
    // supersede each other forever — while `describe()` still reports two and a dispatch to the
    // other name answers `browser_not_here` with that machine plainly connected.
    const S = "s".repeat(32);
    assert.throws(() => parseTokenList(`laptop=${S},desktop=${S}`), /share the same secret/);
  });

  it("so no secret can ever resolve to two different browsers", () => {
    // The property the two refusals above exist to produce, asserted directly.
    const p = resolveAuthProvider({
      RELAY_AUTH: "token",
      RELAY_CONTROL_KEY: CONTROL,
      RELAY_TOKENS: `laptop=${"a".repeat(32)},desktop=${"b".repeat(32)}`,
    });
    const seen = new Set<string>();
    for (const secret of ["a".repeat(32), "b".repeat(32)]) {
      const v = p.verifyBrowser(secret);
      assert.equal(v.ok, true);
      const id = v.ok ? v.identity.browserId : "";
      assert.equal(seen.has(id), false, `${id} was returned for two different secrets`);
      seen.add(id);
    }
    assert.equal(seen.size, 2);
  });

  it("refuses a secret short enough to guess", () => {
    assert.throws(() => parseTokenList("laptop=hunter2"), /shorter than/);
  });

  it("refuses an entry that is not name=secret", () => {
    assert.throws(() => parseTokenList("justatoken"), /not name=secret/);
    assert.throws(() => parseTokenList(`=${"a".repeat(32)}`), /not name=secret/);
  });
});

describe("the ticket format is the thing that must not move", () => {
  it("still signs the same bytes for the same claims", () => {
    // A byte-for-byte pin. The minting side lives in another package and is checked against this
    // one by `scripts/crew/check-browser-ticket-parity.mjs`; this asserts the format did not drift
    // during a refactor that moved the file, in case that guard is ever skipped.
    assert.equal(
      mintRelayTicket(
        "k".repeat(64),
        { ownerId: "uid_navid", browserId: "brw_mac" },
        1_700_000_000_000
      ),
      "eyJ2IjoxLCJ1IjoidWlkX25hdmlkIiwiYiI6ImJyd19tYWMiLCJleHAiOjE3MDAwMDA2MDAwMDB9" +
        "._23TJqKnROZV7uRFAKvviEcP4pcj4dgulb76EPjddQw"
    );
  });
});
