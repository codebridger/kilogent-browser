// Assembling a relay: hub + metrics + control plane + one HTTP server carrying both faces.
//
// Separated from index.ts so the tests can start a REAL one — real sockets, real HTTP, real
// tickets — on an ephemeral port. Everything interesting about this program is in how the pieces
// meet (a supersede racing a dispatch, an upgrade on the wrong path, a drain with work in
// flight), and none of that is reachable by testing the pieces alone.

import { WebSocketServer } from "ws";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RelayConfig } from "./config.js";
import { BrowserHub } from "./hub.js";
import { RelayMetrics } from "./metrics.js";
import { createControlPlane } from "./control.js";
import { HealthReporter } from "./health.js";
import { RELAY_VERSION } from "./version.js";

/** One WS text frame's ceiling. `protocol.ts` bounds what a well-formed frame may CONTAIN; this
 *  bounds what gets buffered before any schema ever sees it, which is the half that matters on a
 *  1.9 GB box. `perMessageDeflate` stays off so a small compressed frame cannot expand past a cap
 *  that has already been checked. */
export const MAX_FRAME_BYTES = 12 * 1024 * 1024;

export interface RunningRelay {
  hub: BrowserHub;
  metrics: RelayMetrics;
  server: Server;
  wss: WebSocketServer;
  health: HealthReporter;
  /** The port actually bound — meaningful when the config asked for 0. */
  port: number;
  /** Drain, then stop listening. Safe to call twice. */
  close(graceMs?: number): Promise<void>;
}

export async function startRelay(
  config: RelayConfig,
  log: (msg: string) => void = () => {}
): Promise<RunningRelay> {
  const metrics = new RelayMetrics();
  const hub = new BrowserHub({
    ticketKey: config.ticketKey,
    maxBrowsers: config.maxBrowsers,
    sessionIdleMs: config.sessionIdleMs,
    onBytes: (direction, bytes) => metrics.countBytes(direction, bytes),
    log,
  });

  const server = createControlPlane({
    hub,
    metrics,
    controlKey: config.controlKey,
    instanceId: config.instanceId,
    version: RELAY_VERSION,
    log,
  });

  // `noServer` rather than a second listener: the upgrade is routed by PATH off the same server,
  // so one port serves both faces and there is exactly one Cloudflare ingress rule to get right.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  hub.attach(wss);

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://relay").pathname;
    if (path !== "/ws") {
      // Destroyed, not upgraded-then-closed. Anything reaching another path with an Upgrade
      // header is either confused or probing, and neither deserves a socket.
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const health = new HealthReporter({
    url: config.healthUrl,
    intervalMs: config.healthIntervalMs,
    controlKey: config.controlKey,
    instanceId: config.instanceId,
    version: RELAY_VERSION,
    hub,
    metrics,
    log,
  });

  await new Promise<void>((resolve) => server.listen(config.port, config.bindHost, resolve));
  const port = (server.address() as AddressInfo).port;

  let closed = false;
  return {
    hub,
    metrics,
    server,
    wss,
    health,
    port,
    async close(graceMs = config.drainGraceMs) {
      if (closed) return;
      closed = true;
      health.stop();
      await hub.drain(graceMs);
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
