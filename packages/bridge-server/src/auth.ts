import { timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Authentication for the MCP face.
 *
 * WHY THIS FILE EXISTS. Until now the MCP face had no authentication of any kind — its entire
 * security model was `app.listen(MCP_PORT, "127.0.0.1")`, and BRIDGE-SETUP.md said so outright:
 * "The MCP face (:3000) stays localhost-only, never tunneled." That is a real boundary right up
 * until somebody adds one ingress rule, and the setup doc walks the reader toward exactly that.
 * The failure is not subtle: the URL alone would be a fully logged-in Chrome sitting on a human's
 * home IP, with their cookies, sessions and password manager.
 *
 * It is also weaker than it looks even unexposed. Loopback is not a user boundary — every process
 * and every other account on that VM can reach 127.0.0.1, and a bridge is exactly the kind of thing
 * that ends up on a shared box.
 *
 * A SEPARATE TOKEN FROM THE WS FACE, deliberately. The two faces authenticate different parties: a
 * browser extension dialling in, and an agent asking for work. Sharing one secret would mean a
 * leaked MCP token also lets the holder impersonate the extension — and since the WS token is typed
 * into a popup on somebody's laptop while the MCP token is pasted into an agent config, they leak
 * through completely different accidents.
 *
 * CONSTANT-TIME COMPARISON, matching what the WS handshake already does. A `===` on a secret leaks
 * its prefix through timing; the amount leaked per request is tiny and the number of requests an
 * attacker may make is not.
 */

/** Compare two secrets without leaking their common prefix through timing. */
export function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // `timingSafeEqual` throws on a length mismatch, which would itself be a length oracle — so the
  // lengths are compared first and the buffers are only handed over when they can be compared.
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** The bearer token on a request, or null. Accepts only `Authorization: Bearer <token>`. */
export function bearerFrom(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Refuse any request that does not carry the MCP token.
 *
 * Answers with an HTTP 401 AND a JSON-RPC error body, because the caller is an MCP client: a bare
 * status code surfaces to the operator as an unexplained transport failure, while a JSON-RPC error
 * is rendered as a message they can act on.
 *
 * Mounted as middleware ahead of the route rather than checked inside it, so it covers all three
 * paths through `/mcp` — the existing-session path, the initialize path, and the stateless
 * back-compat fallback. That last one is the reason this must not be a check inside the handler:
 * anything keyed on the session is simply absent there, so a gate placed later would be opt-out by
 * omitting a header.
 */
export function requireBearer(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = bearerFrom(req);
    if (presented !== null && constantTimeEquals(presented, token)) {
      next();
      return;
    }
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "Unauthorized. This bridge requires an MCP token — pass it as `Authorization: Bearer <token>` " +
          "(with Claude Code: `claude mcp add --transport http browser <url> --header \"Authorization: Bearer <token>\"`).",
      },
      id: null,
    });
  };
}
