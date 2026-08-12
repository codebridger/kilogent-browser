// The provider registry — one door, and the place a fork adds its own.
//
// HOW TO ADD ONE. Write `providers/<yours>/index.ts` exporting a factory, add one line to
// `BUILT_IN` below, and set `RELAY_AUTH=<yours>`. Nothing else in the relay changes, and nothing
// outside `providers/` ever learns your provider exists. That is the whole contract: a fork
// touches this file and its own directory, so `git merge upstream/main` stays clean forever.
//
// A provider that needs to hold state (a key set it refreshes, a revocation list) closes over it in
// the factory. The factory runs ONCE at startup, which is also why a bad configuration throws here
// rather than on somebody's first click.

import type { AuthProvider, AuthProviderFactory } from "./types.js";
import { createTicketProvider } from "./ticket/index.js";
import { createTokenProvider } from "./token/index.js";

export type {
  AuthProvider,
  AuthProviderFactory,
  MintInput,
  VerifyFailure,
  VerifyResult,
} from "./types.js";
export { constantTimeEquals } from "./secrets.js";

const BUILT_IN: Record<string, AuthProviderFactory> = {
  ticket: createTicketProvider,
  token: createTokenProvider,
};

/** The default. Chosen so an existing deployment that never heard of `RELAY_AUTH` keeps the
 *  behaviour it already had — a new required variable is an outage on the next restart. */
export const DEFAULT_AUTH = "ticket";

/** Every provider this build has, for `doctor` and for the refusal message. */
export function authProviderNames(): string[] {
  return Object.keys(BUILT_IN);
}

export function resolveAuthProvider(env: NodeJS.ProcessEnv): AuthProvider {
  const name = (env.RELAY_AUTH ?? DEFAULT_AUTH).trim().toLowerCase();
  const factory = BUILT_IN[name];
  if (!factory) {
    throw new Error(
      `RELAY_AUTH=${JSON.stringify(name)} is not a provider this build has.\n` +
        `Built in: ${authProviderNames().join(", ")}.\n` +
        "A fork adds its own in providers/<name>/ and one line in providers/index.ts."
    );
  }
  return factory(env);
}
