// The control plane — the face Lumi Crew talks to.
//
// Hand-rolled on `node:http` rather than express, for two reasons that both matter on an
// internet-facing box: it is four routes, and every dependency on a published package that runs
// here is a supply-chain surface in front of somebody's logged-in Chrome. The body reader below
// is the only thing express was buying, and a hard byte cap enforced before parsing is stricter
// than what a middleware default gives us anyway.
//
// The WS upgrade shares this server on `/ws`. One port, one Cloudflare ingress rule — see
// config.ts. Two ports would mean two rules, and the day someone adds only one of them the
// symptom is browsers that connect but never receive work, or work that dispatches into nothing.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { BrowserHub, DispatchOutcome } from "./hub.js";
import type { RelayMetrics } from "./metrics.js";

/** Enough for a long `type` action; a screenshot travels the OTHER way. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * The relay's own slice of the nested timeout budget.
 *
 * Crew aborts at 25 s and asks for 20 s here. The clamp is not for Crew — it is so that a caller
 * holding the control key cannot pin a pending slot for ten minutes and starve a browser that is
 * doing real work.
 */
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;

const dispatchSchema = z.object({
  ownerUid: z.string().min(1).max(200),
  browserId: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  args: z.record(z.unknown()).default({}),
  timeoutMs: z.number().int().default(20_000),
  sessionId: z.string().min(1).max(200).optional(),
  blockedOrigins: z.array(z.string().max(500)).max(500).optional(),
});

const sessionCloseSchema = z.object({
  ownerUid: z.string().min(1).max(200),
  browserId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
});

function keyEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function bearerFrom(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // Nothing here is ever a browser navigation, but a relay behind Cloudflare should never have
    // an answer about one person's browser cached by anything in the path.
    "cache-control": "no-store",
  });
  res.end(payload);
}

/** Read a bounded JSON body, or null if it is too big or not JSON. */
async function readJson(req: IncomingMessage): Promise<unknown | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let aborted = false;
    req.on("data", (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => {
      if (!aborted) resolve(null);
    });
  });
}

/**
 * HTTP status for a dispatch outcome.
 *
 * The BODY's `outcome` is the contract; the status is a courtesy for anything in between that only
 * reads numbers. Crew must key on the string — `browser_not_here` and `disconnected` share a 409
 * because they are the same thing to a proxy and very different things to an agent.
 */
function statusFor(outcome: DispatchOutcome["outcome"]): number {
  switch (outcome) {
    case "ok":
      return 200;
    case "browser_not_here":
    case "disconnected":
      return 409;
    case "busy":
      return 429;
    case "timeout":
      return 504;
    case "send_failed":
      return 502;
  }
}

export interface ControlPlaneOptions {
  hub: BrowserHub;
  metrics: RelayMetrics;
  controlKey: string;
  instanceId: string;
  version: string;
  log?: (msg: string) => void;
}

export function createControlPlane(opts: ControlPlaneOptions): Server {
  const { hub, metrics, controlKey } = opts;

  const authed = (req: IncomingMessage, res: ServerResponse): boolean => {
    const token = bearerFrom(req);
    if (token && keyEquals(token, controlKey)) return true;
    // No detail. The caller is our own backend and already knows its key; anyone else learns
    // nothing about whether the header was missing, malformed, or simply wrong.
    json(res, 401, { error: "unauthorized" });
    return false;
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "relay"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // Liveness ONLY, and unauthenticated on purpose: the tunnel's health check and an operator's
    // curl both need an answer before any key is in play. It says the process is up and NOTHING
    // about who is connected — that is a description of specific people's browsers, and it lives
    // behind the key at /v1/health. This is the same line bridge-server drew, for the same reason.
    if (method === "GET" && (path === "/health" || path === "/")) {
      json(res, 200, { status: "ok", service: "lumi-relay", version: opts.version });
      return;
    }

    if (method === "GET" && path === "/v1/health") {
      if (!authed(req, res)) return;
      json(res, 200, {
        status: "ok",
        service: "lumi-relay",
        version: opts.version,
        instanceId: opts.instanceId,
        ...metrics.snapshot(hub.size, hub.inFlight()),
      });
      return;
    }

    if (method === "GET" && path === "/v1/browsers") {
      if (!authed(req, res)) return;
      const ownerUid = url.searchParams.get("ownerUid") ?? undefined;
      const browserId = url.searchParams.get("browserId") ?? undefined;
      json(res, 200, { browsers: hub.list({ ownerUid, browserId }) });
      return;
    }

    if (method === "POST" && path === "/v1/dispatch") {
      if (!authed(req, res)) return;
      const body = await readJson(req);
      const parsed = dispatchSchema.safeParse(body);
      if (!parsed.success) {
        json(res, 400, { error: "invalid_request", detail: parsed.error.issues[0]?.message });
        return;
      }
      const input = parsed.data;
      const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, input.timeoutMs));
      metrics.countDispatch();
      const outcome = await hub.dispatch({ ...input, timeoutMs });
      if (outcome.outcome !== "ok") {
        opts.log?.(`[control] dispatch ${input.name} → ${outcome.outcome} (${input.browserId})`);
      }
      json(res, statusFor(outcome.outcome), outcome);
      return;
    }

    if (method === "POST" && path === "/v1/session/close") {
      if (!authed(req, res)) return;
      const parsed = sessionCloseSchema.safeParse(await readJson(req));
      if (!parsed.success) {
        json(res, 400, { error: "invalid_request", detail: parsed.error.issues[0]?.message });
        return;
      }
      const { ownerUid, browserId, sessionId } = parsed.data;
      // A browser that is not here is a SUCCESS, not an error: the tabs we were asked to close
      // went with it. Making the caller handle a failure for "already gone" would mean Crew
      // retrying a teardown that can never be needed.
      const delivered = hub.closeSession(ownerUid, browserId, sessionId);
      json(res, 200, { closed: true, delivered });
      return;
    }

    json(res, 404, { error: "not_found" });
  });
}
