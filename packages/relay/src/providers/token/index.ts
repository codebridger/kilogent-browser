// The `token` provider — a static secret per machine, and nothing else to run.
//
// This exists so somebody can have a working relay in five minutes without building a minting
// service first. It is the honest floor of the seam: no signing, no expiry, no second system.
//
//   RELAY_TOKENS="laptop=<secret>,desktop=<secret>"   one entry per machine
//   RELAY_TOKEN="<secret>"                            shorthand for a single machine named `browser`
//   RELAY_OWNER_ID="local"                            who all of them belong to
//
// THE NAME IS THE IDENTITY. A machine's `browserId` is its key in that list, so two Chrome profiles
// need two entries — not because the secrets must differ for security, but because a shared name
// means a shared hub key, and the second connection would supersede the first forever. The list is
// what makes that a configuration choice rather than a mystery.
//
// WHAT YOU GIVE UP versus `ticket`, stated plainly so nobody discovers it later:
//   • These credentials never expire. Removing a machine's access means editing the file and
//     restarting, not waiting ten minutes.
//   • The secret is at rest on the browser's machine for as long as it is installed, rather than
//     being fetched per socket and thrown away.
//   • There is no per-user story. Every machine here belongs to one owner id.
// For anything with more than one person in it, mint tickets.

import { constantTimeEquals } from "../secrets.js";
import { isValidIdComponent } from "../../identity.js";
import type { AuthProvider, VerifyResult } from "../types.js";

const DEFAULT_OWNER = "local";
const DEFAULT_BROWSER = "browser";
/** Same floor as the ticket key. A hand-typed word is not a credential for an internet-facing box. */
export const MIN_TOKEN_LENGTH = 16;

/** Parse `name=secret,name=secret`. Whitespace around either half is ignored; a secret may not
 *  contain a comma, which is why the shorthand exists for the awkward ones. */
export function parseTokenList(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new Error(
        `RELAY_TOKENS entry ${JSON.stringify(trimmed)} is not name=secret.\n` +
          'Example: RELAY_TOKENS="laptop=abc…,desktop=def…"'
      );
    }
    const name = trimmed.slice(0, eq).trim();
    const secret = trimmed.slice(eq + 1).trim();
    if (!isValidIdComponent(name)) {
      throw new Error(`RELAY_TOKENS: ${JSON.stringify(name)} is not a usable browser name.`);
    }
    if (secret.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `RELAY_TOKENS: the secret for ${JSON.stringify(name)} is shorter than ${MIN_TOKEN_LENGTH} ` +
          "characters.\n  openssl rand -hex 32"
      );
    }
    if (out.has(name)) throw new Error(`RELAY_TOKENS: ${JSON.stringify(name)} appears twice.`);
    // A duplicate SECRET is the subtler half, and refusing it is not tidiness. Two names sharing
    // one secret both resolve to whichever entry the scan happens to keep, so the two machines
    // share a hub key and supersede each other forever — the exact failure the per-machine list
    // exists to prevent — while `describe()` still reports two browsers and a dispatch to the
    // other name answers `browser_not_here` with that machine plainly connected.
    for (const [other, existing] of out) {
      if (existing === secret) {
        throw new Error(
          `RELAY_TOKENS: ${JSON.stringify(name)} and ${JSON.stringify(other)} share the same ` +
            "secret, so both would connect as the same browser. Give each machine its own."
        );
      }
    }
    out.set(name, secret);
  }
  return out;
}

export function createTokenProvider(env: NodeJS.ProcessEnv): AuthProvider {
  const ownerId = (env.RELAY_OWNER_ID ?? DEFAULT_OWNER).trim();
  if (!isValidIdComponent(ownerId)) {
    throw new Error(`RELAY_OWNER_ID ${JSON.stringify(ownerId)} is not a usable id.`);
  }

  const browsers = parseTokenList(env.RELAY_TOKENS ?? "");
  const single = (env.RELAY_TOKEN ?? "").trim();
  if (single) {
    if (single.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `RELAY_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.\n  openssl rand -hex 32`
      );
    }
    if (browsers.has(DEFAULT_BROWSER)) {
      throw new Error(
        `RELAY_TOKEN and a RELAY_TOKENS entry named ${JSON.stringify(DEFAULT_BROWSER)} both set. ` +
          "Use one or the other."
      );
    }
    browsers.set(DEFAULT_BROWSER, single);
  }

  if (browsers.size === 0) {
    throw new Error(
      "RELAY_AUTH=token, but neither RELAY_TOKEN nor RELAY_TOKENS is set, so no browser could\n" +
        "ever connect. Generate a secret and name the machine it belongs to:\n\n" +
        '  RELAY_TOKENS="laptop=$(openssl rand -hex 32)"\n'
    );
  }

  const controlKey = env.RELAY_CONTROL_KEY ?? "";
  // A secret that is also a browser's credential would let a machine dispatch to itself and to
  // every sibling. Refused here for the same reason `ticket` refuses a shared key.
  for (const [name, secret] of browsers) {
    if (secret === controlKey) {
      throw new Error(
        `RELAY_CONTROL_KEY is the same value as the token for ${JSON.stringify(name)}. ` +
          "A browser's credential must never also open the control plane."
      );
    }
  }

  return {
    name: "token",
    verifyBrowser(credential: unknown): VerifyResult {
      if (typeof credential !== "string" || credential.length === 0) {
        return { ok: false, reason: "unauthorized" };
      }
      // Every entry is compared even after a hit, so the time taken does not depend on WHICH
      // machine's token was presented. `constantTimeEquals` already length-guards each one.
      // The FIRST match wins rather than the last — with duplicate secrets refused at parse time
      // there can only be one, and "first" is the answer that stays right if that guard is ever
      // weakened.
      let matched: string | null = null;
      for (const [name, secret] of browsers) {
        if (constantTimeEquals(credential, secret) && matched === null) matched = name;
      }
      if (matched === null) return { ok: false, reason: "unauthorized" };
      // `expiresAt: 0` — never. See BrowserIdentity: it is reported, not enforced.
      return { ok: true, identity: { ownerId, browserId: matched, expiresAt: 0 } };
    },
    verifyDispatch(bearer: string | null): boolean {
      return bearer !== null && controlKey.length > 0 && constantTimeEquals(bearer, controlKey);
    },
    // No `mint`. The credential IS the configuration — there is nothing to derive, and printing
    // something that looks like one would be worse than refusing.
    describe(): string {
      const names = [...browsers.keys()].join(", ");
      return `token (${browsers.size} browser(s): ${names}; owner ${ownerId}; no expiry)`;
    },
  };
}
