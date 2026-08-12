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
      userAgent: navigator.userAgent,
      extensionVersion: chrome.runtime.getManifest().version,
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
  // TWO MESSAGES BELONG TO EVERY TRANSPORT AT ONCE, and are answered here rather than offered to
  // one. `registry.onMessage` hands a message to the FIRST transport that claims it — right for
  // `saveProfiles` or `signIn`, and exactly wrong for these two, where the first transport in the
  // list would answer on behalf of the whole extension and the rest would never be asked.
  if (msg && msg.type === "getStatus") {
    sendResponse(registry.status());
    return true;
  }
  if (msg && msg.type === "reconnect") {
    registry.reconnectAll();
    sendResponse({ ok: true });
    return true;
  }

  // `true` keeps the message channel open for an async reply and MUST be returned synchronously,
  // so the work starts and `true` is returned before any await. We cannot know synchronously
  // whether a transport will claim it, so the channel is always held: an unclaimed message resolves
  // with `handled: false`, nothing is sent, and the port simply closes.
  registry
    .onMessage(msg)
    .then((outcome) => {
      if (outcome.handled) sendResponse(outcome.response);
    })
    .catch((err) => {
      log("[sw] message handling failed:", err);
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    });
  return true;
});

void registry.reconcile();
