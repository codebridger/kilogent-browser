// The auth seam. Core never authenticates anything; it asks a provider.
//
// THE SPLIT THAT MATTERS, and it is not the obvious one. There are two questions in front of a
// relay, and only ONE of them belongs here:
//
//   "who are you"  →  the relay answers it.   A credential is verified locally, and the identity
//                     it proves decides which socket a dispatch reaches.
//   "may you"      →  the relay must NEVER answer it.  Whether a given agent may drive a given
//                     browser right now depends on live state — memberships, approvals, settings —
//                     and the relay holds none of it. A policy cached here is a policy that keeps
//                     saying yes after somebody revoked it.
//
// So `verifyDispatch` below is deliberately narrow: it asks whether the CALLER may use the control
// plane at all, not what it may do with it. The system that holds the state answers the rest, and
// re-answers it on every call.
//
// VERIFICATION MUST BE LOCAL. `verifyBrowser` runs on every reconnect and `verifyDispatch` on every
// single command; a provider that calls out to an identity server turns each of those into a
// network round trip, on the hot path, on a box whose whole job is latency. Verify a signature, or
// compare a secret you already hold. If a design needs a lookup, it needs a short-lived signed
// credential minted by whatever does the lookup — which is exactly what the `ticket` provider is.

import type { BrowserIdentity } from "../identity.js";

export type VerifyFailure =
  /** Not a credential we recognise, or the signature does not match. Indistinguishable on
   *  purpose — a caller learns nothing about which half was wrong. */
  | { ok: false; reason: "unauthorized" }
  /** Genuinely ours, genuinely too old. A SEPARATE outcome because the client's correct response
   *  differs: get another and retry NOW, rather than back off and eventually give up. A client
   *  that treats this as an auth failure is a browser that silently stops working. */
  | { ok: false; reason: "ticket_expired" };

export type VerifyResult = { ok: true; identity: BrowserIdentity } | VerifyFailure;

export interface MintInput {
  ownerId: string;
  browserId: string;
  /** Overrides the provider's default lifetime. Ignored by providers whose credentials never
   *  expire. */
  ttlMs?: number;
}

export interface AuthProvider {
  /** Its name in `RELAY_AUTH`. Appears in the startup log and in `doctor`. */
  readonly name: string;

  /**
   * "Who is this browser?" — called once per socket, on the hello frame.
   *
   * Must not throw: a throw here happens inside a WebSocket message handler, where the only
   * available response is to take the socket down with no explanation.
   */
  verifyBrowser(credential: unknown, now?: number): VerifyResult;

  /**
   * "May this caller use the control plane?" — called on every control-plane request.
   *
   * Takes the raw bearer token, or null when the header was absent or malformed, so a provider
   * that wants to accept an unauthenticated read can say so rather than having the decision made
   * for it. Constant-time comparison is the provider's responsibility; `constantTimeEquals` in
   * `./index.ts` is there for it.
   */
  verifyDispatch(bearer: string | null): boolean;

  /**
   * Mint a browser credential — optional, because not every scheme can.
   *
   * Present on `ticket` (it holds the signing key) and absent on `token` (the credential IS the
   * configuration, so there is nothing to derive). `relay ticket` refuses by name when it is
   * absent, rather than printing something that will not work.
   */
  mint?(input: MintInput, now?: number): string;

  /** One line for the startup log and `doctor`. MUST NOT contain a secret — it is printed. */
  describe(): string;
}

/** Built once, at startup, from the environment. Throwing here is how a misconfiguration becomes
 *  a refusal to start rather than a refusal on somebody's first click. */
export type AuthProviderFactory = (env: NodeJS.ProcessEnv) => AuthProvider;
