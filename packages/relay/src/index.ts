#!/usr/bin/env node
// lumi-relay — the thing a browser phones, so an agent has something to call.
//
// A browser on somebody's laptop has no address. It sits behind NAT, sleeps, changes networks,
// and is not a server. So it dials OUT and stays on the line, and this process is what it dials.
// Crew then addresses a machine it can never reach directly by naming it —
// `${ownerUid}:${browserId}` — to a box that can.
//
// Two faces, ONE port:
//   • `/ws`    the extension's WebSocket. Authenticated in-band by a Crew-minted ticket, because
//              a browser WebSocket cannot send headers — which is also why this route has no
//              Cloudflare Access policy and the ticket is the whole gate.
//   • `/v1/*`  the control plane Crew calls. Bearer-authenticated with a DIFFERENT secret, and
//              Access-protected at the edge, because that caller IS a server and can send headers.
//
// It holds no Firebase credential and never talks to Firestore. Presence and dispatch, nothing
// else: whether a given agent may drive a given browser right now is Crew's decision, re-made from
// live documents on every single call.

import { loadConfig } from "./config.js";
import { startRelay } from "./server.js";
import { RELAY_VERSION } from "./version.js";

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  const relay = await startRelay(config, log);

  log(`lumi-relay ${RELAY_VERSION} (${config.instanceId})`);
  log(`  control : http://${config.bindHost}:${relay.port}/v1/*  (bearer required)`);
  log(`  browsers: ws://${config.bindHost}:${relay.port}/ws      (ticket required)`);
  log(`  liveness: http://${config.bindHost}:${relay.port}/health`);
  if (config.bindHost !== "127.0.0.1" && config.bindHost !== "localhost") {
    log(`  NOTE    : bound to ${config.bindHost}, not loopback — the keys are all that is in front.`);
  }
  relay.health.start();

  // ── shutdown ─────────────────────────────────────────────────────────────────────────────
  //
  // Drain BEFORE closing: an in-flight command is a click somebody's agent already committed to,
  // and hanging up on it mid-air is the one failure a restart should never cause. Sockets are then
  // closed with 1012 "Service Restart", which the extension's existing backoff already treats as
  // temporary — so an upgrade costs a browser a few seconds of reconnect and needs no extension
  // change at all.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(
      `[shutdown] ${signal} — draining ${relay.hub.inFlight()} command(s) from ${relay.hub.size} browser(s)`
    );
    await relay.close();
    log("[shutdown] done");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main();
