// Secret comparison, in its own module so a provider can use it without importing the registry
// that imports the provider. (It lived in `providers/index.ts` for about ten minutes and made an
// import cycle that only worked by accident of function hoisting.)

import { timingSafeEqual } from "node:crypto";

/** Below this, a secret is short enough to be guessable. `openssl rand -hex 32` produces 64. */
export const MIN_KEY_LENGTH = 32;

/**
 * Compare two secrets without leaking which byte differed.
 *
 * Length is checked first because `timingSafeEqual` THROWS on a length mismatch — a throw here
 * would be both a crash and a timing signal. The lengths themselves are not secret.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
