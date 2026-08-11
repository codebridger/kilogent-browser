// The `bridge` transport — the self-hosted path, and the only one this repository ships.
//
// You run `packages/bridge-server` yourself, put its URL and shared token into the popup, and this
// dials out to it. Several profiles can be configured at once, each its own connection with its own
// Executor, so their tabs never mix.
//
// It is a thin wrapper around `ConnectionManager`, which already did all of this. The wrapper
// exists so the worker talks to one shape rather than to this class specifically — the difference
// between adding a second transport being a new directory and being surgery on `sw.js`.

import { Executor } from "../../executor.js";
import { ConnectionManager } from "../../connection.js";

/** The popup messages this transport answers. Anything else it passes on. */
const MINE = new Set(["getStatus", "saveProfiles", "reconnect"]);

/**
 * @param {{storage: any, WebSocketCtor: typeof WebSocket, log?: (...a:any[]) => void}} deps
 *   `storage` and `WebSocketCtor` are injected rather than reached for, so this file has no Chrome
 *   API in it and the registry's test can construct one.
 */
export function createBridgeTransport(deps) {
  const log = deps.log || (() => {});
  const storage = deps.storage;

  const manager = new ConnectionManager({
    WebSocketCtor: deps.WebSocketCtor,
    makeExecutor: (pushStatus, label) => new Executor(pushStatus, label),
    onStateChange: () => {},
    log,
  });

  /**
   * Load the profile list, migrating the legacy single `{agentUrl, accessToken}` pair.
   *
   * The migration writes the new shape back, so it runs once and then costs one read forever. It
   * is kept because the alternative is a person who set this up early opening the popup one day to
   * find it empty and their bridge silently disconnected.
   */
  async function loadProfiles() {
    const store = await storage.get(["profiles", "agentUrl", "accessToken"]);
    if (Array.isArray(store.profiles)) return store.profiles;
    const profiles = store.agentUrl
      ? [
          {
            id: crypto.randomUUID(),
            name: "Default",
            agentUrl: store.agentUrl,
            accessToken: store.accessToken || "",
            enabled: true,
          },
        ]
      : [];
    await storage.set({ profiles });
    return profiles;
  }

  return {
    name: "bridge",

    async reconcile() {
      manager.reconcile(await loadProfiles());
    },

    reconnectAll() {
      manager.reconnectAll();
    },

    onDetach(source, reason) {
      manager.onDetach(source, reason);
    },

    onTabRemoved(tabId) {
      manager.onTabRemoved(tabId);
    },

    status() {
      // `{profiles: [...]}` at the top level — the shape the popup has always read.
      return manager.statusSnapshot();
    },

    onMessage(msg) {
      if (!msg || !MINE.has(msg.type)) return undefined; // not mine — see registry.onMessage
      if (msg.type === "getStatus") return manager.statusSnapshot();
      if (msg.type === "reconnect") {
        manager.reconnectAll();
        return { ok: true };
      }
      // saveProfiles
      return storage
        .set({ profiles: msg.profiles })
        .then(() => manager.reconcile(msg.profiles))
        .then(() => ({ ok: true }));
    },

    teardown() {
      manager.reconcile([]); // tears every connection down
    },
  };
}
