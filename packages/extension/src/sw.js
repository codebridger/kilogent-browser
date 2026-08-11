// MV3 service worker. Chrome's plumbing, and nothing else.
//
// Every Chrome API this extension uses is registered here and immediately handed to the transport
// registry, which decides what actually happens. That split is deliberate and it is what makes a
// fork viable: a build that adds its own way of reaching an agent writes a directory under
// `providers/` and one line in `providers/index.js`, and this file stays exactly as upstream wrote
// it. It is also why this file is barely testable and does not need to be — there is no decision
// left in it. The decisions are in `providers/registry.js`, which has no Chrome API in it and is
// covered by `scripts/registry-test.mjs`.
//
// Keepalive (the make-or-break MV3 piece): each connection's server sends an app-level
// `{t:"ping"}` every ~20s; each inbound WS frame fires a service-worker event and resets MV3's
// ~30s idle timer, keeping the worker resident while its window is unfocused. A 1-minute
// `chrome.alarms` reconciles connections as a revival backstop if the worker is evicted anyway.
// All connection state is rebuilt on cold start from storage — nothing here survives eviction, and
// nothing is expected to.

import { TransportRegistry } from "./providers/registry.js";
import { TRANSPORTS } from "./providers/index.js";

const log = (...a) => console.log(...a);

const registry = new TransportRegistry(
  TRANSPORTS.map((make) =>
    make({
      // Injected rather than reached for, so a transport is loadable outside a browser and the
      // registry's own test needs no Chrome shim.
      storage: chrome.storage.local,
      WebSocketCtor: WebSocket,
      log,
    })
  ),
  { log }
);

// ── top-level registration (re-runs on every cold start) ──────────────────────
chrome.alarms.create("keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive") void registry.reconcile();
});
chrome.runtime.onStartup.addListener(() => void registry.reconcile());
chrome.runtime.onInstalled.addListener(() => void registry.reconcile());
chrome.debugger.onDetach.addListener((source, reason) => registry.onDetach(source, reason));
chrome.tabs.onRemoved.addListener((tabId) => registry.onTabRemoved(tabId));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // `true` keeps the message channel open for an async reply, and MUST be returned synchronously —
  // so the work is started and `true` returned before any await. Returning `false` for a message
  // nobody claimed is what stops Chrome waiting for a reply that will never come.
  let claimed = false;
  registry
    .onMessage(msg)
    .then((outcome) => {
      claimed = outcome.handled;
      if (outcome.handled) sendResponse(outcome.response);
    })
    .catch((err) => {
      log("[sw] message handling failed:", err);
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    });
  // We cannot know synchronously whether a transport will claim it, so we always hold the channel.
  // An unclaimed message resolves with `handled: false`, nothing is sent, and the port closes.
  void claimed;
  return true;
});

void registry.reconcile();
