// `relay ticket` — mint one browser credential with the configured provider.
//
// WHY THIS COMMAND EXISTS. The relay could VERIFY a credential and never hand you one, so
// `RELAY_AUTH=ticket` was unusable by anyone who had not already built a minting service. That is
// invisible when the only deployment is one whose backend does the minting, and it is the entire
// barrier to entry for everyone else: a provider worth reading and impossible to try.
//
// The DECISION is separated from the printing so it can be tested without spawning a process.
// Everything commander touches is in `index.ts`; everything that can be wrong is here.

import { resolveAuthProvider } from "../providers/index.js";

export interface TicketOptions {
  owner: string;
  browser: string;
  /** Minutes, as typed. Parsed here so a bad value is a refusal rather than a NaN expiry. */
  ttl?: string;
}

export type TicketPlan =
  | { ok: true; credential: string; note: string }
  | { ok: false; message: string };

export function planTicket(
  env: NodeJS.ProcessEnv,
  options: TicketOptions,
  now?: number
): TicketPlan {
  let auth;
  try {
    auth = resolveAuthProvider(env);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  if (!auth.mint) {
    // Refused BY NAME rather than generically: a provider without a mint is a design choice, not a
    // missing feature, and the message must not read like something is broken.
    return {
      ok: false,
      message:
        `The \`${auth.name}\` provider does not mint credentials — with it, a browser's token IS\n` +
        "the configuration. See RELAY_TOKENS in the relay's environment.",
    };
  }

  let ttlMs: number | undefined;
  if (options.ttl !== undefined) {
    const minutes = Number.parseFloat(options.ttl);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return {
        ok: false,
        message: `--ttl must be a positive number of minutes, got ${JSON.stringify(options.ttl)}`,
      };
    }
    ttlMs = Math.round(minutes * 60_000);
  }

  try {
    return {
      ok: true,
      credential: auth.mint({ ownerId: options.owner, browserId: options.browser, ttlMs }, now),
      note: `${auth.describe()} — paste this into the extension's connect field.`,
    };
  } catch (err) {
    // The provider's own refusal (an id with a colon in it, a missing key). Its wording is better
    // than anything this layer could invent.
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
