// The `ticket` provider — short-lived signed credentials minted by whatever owns the accounts.
//
// This is the shape to copy when a system already knows who its users are. It needs exactly two
// shared secrets and no network path between the relay and that system:
//
//   RELAY_TICKET_KEY   the HMAC key tickets are SIGNED with. The minting side holds the same value.
//   RELAY_CONTROL_KEY  the bearer token that side sends when dispatching a command.
//
// TWO KEYS, AND THEY MUST DIFFER. The control key travels in a header on every dispatch, hundreds
// of times a minute, into anything that logs a request. The ticket key is a SIGNING key: it never
// leaves this process and the minter's, and whoever holds it can mint a ticket, connect as
// somebody else's browser, and receive that person's dispatches. A signing key must never be the
// thing you put in a header — sharing one would make the leak with the largest exposure surface
// also the leak with the worst consequence.

import { constantTimeEquals, MIN_KEY_LENGTH } from "../secrets.js";
import type { AuthProvider, MintInput, VerifyResult } from "../types.js";
import { mintRelayTicket, TICKET_TTL_MS, verifyRelayTicket } from "./ticket.js";

export { TICKET_TTL_MS, TICKET_VERSION, mintRelayTicket, verifyRelayTicket } from "./ticket.js";

export function createTicketProvider(env: NodeJS.ProcessEnv): AuthProvider {
  const ticketKey = env.RELAY_TICKET_KEY ?? "";
  const controlKey = env.RELAY_CONTROL_KEY ?? "";

  if (!ticketKey) {
    throw new Error(
      "RELAY_TICKET_KEY is not set. This is the key browser tickets are SIGNED with; without it\n" +
        "no extension could ever connect. Generate one and put it in the relay's environment:\n\n" +
        "  openssl rand -hex 32\n\n" +
        "The same value must reach whatever mints tickets. Use a DIFFERENT value from\n" +
        "RELAY_CONTROL_KEY — see providers/ticket/index.ts for why."
    );
  }
  if (controlKey === ticketKey) {
    throw new Error(
      "RELAY_CONTROL_KEY and RELAY_TICKET_KEY are the same value. One is sent in a header on\n" +
        "every dispatch; the other signs the tickets that let a browser prove who it is. Sharing\n" +
        "one means the credential with the widest exposure is also the one that can impersonate\n" +
        "any connected browser. Generate a second one."
    );
  }
  if (ticketKey.length < MIN_KEY_LENGTH) {
    throw new Error(
      `RELAY_TICKET_KEY must be at least ${MIN_KEY_LENGTH} characters.\n` +
        "`openssl rand -hex 32` produces 64."
    );
  }

  return {
    name: "ticket",
    verifyBrowser(credential: unknown, now?: number): VerifyResult {
      return verifyRelayTicket(ticketKey, credential, now);
    },
    verifyDispatch(bearer: string | null): boolean {
      return bearer !== null && constantTimeEquals(bearer, controlKey);
    },
    mint(input: MintInput, now?: number): string {
      return mintRelayTicket(ticketKey, input, now);
    },
    describe(): string {
      return `ticket (HMAC-SHA256, ${Math.round(TICKET_TTL_MS / 60_000)} min)`;
    },
  };
}
