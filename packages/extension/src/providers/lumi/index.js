// The `lumi` transport — a hosted service, and the worked example of a second one.
//
// One socket to Lumi's relay, authenticated by a short-lived ticket the service mints per
// connection, serving every workspace this person lends the browser to. It sits beside the
// self-hosted `bridge` transport rather than replacing it: both can be live at once, and neither
// knows the other exists.
//
// THIS FILE IS WHY THE SEAM EXISTS. All of it — the session, the device handshake, the ticket
// mint, the heartbeat, the blocklist — used to live inside `sw.js`, which grew from 69 lines to
// 390 and made every merge from upstream a conflict. Nothing here touches `sw.js`, `executor.js`,
// `page-scripts.js` or `connection.js`, which is the rule a fork has to keep.
//
// It also found a real hole in the seam. `getStatus` and `reconnect` were being CLAIMED by the
// first transport in the list, so this one could never have received them — a message every
// transport needs is a registry-level call, not a per-transport one. See `registry.onMessage`.

import { Executor } from "../../executor.js";
import { LumiConnection } from "./connection.js";
import { KEYS, SCHEMA_VERSION } from "./config.js";
import {
  callFunction,
  exchangeCustomToken,
  getIdToken,
  loadSession,
  clearSession,
} from "./auth.js";
import { mintTicket, syncShips } from "./api.js";
import { effectiveBlocklist, isBlocked } from "./blocklist.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The popup messages only this transport can answer. `getStatus` and `reconnect` are NOT here —
 *  see the file header. */
const MINE = new Set([
  "beginLogin",
  "cancelLogin",
  "setSession",
  "setShips",
  "setBlocklist",
  "signOut",
]);

/**
 * @param {{
 *   storage: any,
 *   WebSocketCtor: typeof WebSocket,
 *   userAgent?: string,
 *   extensionVersion?: string,
 *   log?: (...a:any[]) => void,
 * }} deps
 *   Everything ambient is injected, so this file has no Chrome or DOM global in it and can be
 *   loaded outside a browser.
 */
export function createLumiTransport(deps) {
  const storage = deps.storage;
  const log = deps.log || (() => {});

  /** The single connection, or null when signed out. One socket serves every workspace. */
  let lumi = null;
  /**
   * The owner's own blocked origins, read once per tick rather than per command — `isBlocked` runs
   * on a hot path.
   */
  let ownBlocklistCache = [];
  /** Workspace ids this browser is offered to. Mirrored so the heartbeat need not re-read storage. */
  let ships = [];
  let lastError = "";
  /**
   * The public half of the session, cached.
   *
   * CACHED RATHER THAN READ, because `status()` must be synchronous — the popup calls it on every
   * open and a transport that goes to storage there turns one slow read into a popup that hangs
   * for every transport at once. Refreshed wherever the session changes.
   */
  let publicSession = null;

  async function refreshPublicSession() {
    const s = await loadSession(storage);
    publicSession = s
      ? { uid: s.uid, email: s.email ?? "", projectId: s.projectId }
      : null;
  }

  /** This machine's browser id — minted once per Chrome profile and kept forever. It names a
   *  MACHINE, not a membership, which is why one id is correct across every workspace. */
  async function browserId() {
    const store = await storage.get(KEYS.browserId);
    if (store[KEYS.browserId]) return store[KEYS.browserId];
    const id = `brw_${crypto.randomUUID().replace(/-/g, "")}`;
    await storage.set({ [KEYS.browserId]: id });
    return id;
  }

  async function identity() {
    const store = await storage.get([KEYS.label, KEYS.endpoint]);
    return {
      browserId: await browserId(),
      label: store[KEYS.label] || "This browser",
      agentString: (deps.userAgent || "").slice(0, 400),
      extensionVersion: deps.extensionVersion || "",
      endpoint: store[KEYS.endpoint] || "",
    };
  }

  function teardown() {
    lumi?.teardown();
    lumi = null;
  }

  /**
   * Poll an in-flight handshake until it is approved, expires, or is cancelled.
   *
   * Re-entrancy is guarded by `polling` rather than by a lock, because the two entry points — the
   * popup starting a login, and the alarm re-entering after an eviction — can genuinely coincide,
   * and two loops would burn the server's `slow_down` budget against each other.
   *
   * A failed poll is SWALLOWED and retried, except for the terminal statuses. The commonest reason
   * a single poll fails is a network blip, and throwing away a code the human is still typing
   * because of one is the worst possible answer.
   */
  let polling = false;
  async function pollPending() {
    if (polling) return;
    polling = true;
    try {
      await pollLoop();
    } catch (err) {
      // NEVER REJECTS. Both callers start it and walk away — `reconcile()` must not wait ten
      // minutes for a human — so a rejection here has nobody to catch it and becomes an unhandled
      // rejection in the service worker. The failure is recorded where the popup can show it.
      lastError = String(err?.message ?? err);
      log("[lumi] sign-in polling stopped:", err);
    } finally {
      polling = false;
    }
  }

  async function pollLoop() {
    for (;;) {
      const store = await storage.get(KEYS.pending);
      const pending = store[KEYS.pending];
      if (!pending) return;
      if (Date.now() > pending.expiresAt) {
        await storage.remove(KEYS.pending);
        lastError =
          "That sign-in code expired before it was approved. Try again.";
        return;
      }

      let result;
      try {
        result = await callFunction(pending.endpoint, "pollBrowserLogin", {
          userCode: pending.userCode,
          deviceCode: pending.deviceCode,
        });
      } catch (e) {
        // Terminal: the handshake is gone — expired, claimed, or never existed. All three mean
        // start again, so there is nothing to keep polling for.
        if (e.status === "NOT_FOUND" || e.status === "PERMISSION_DENIED") {
          await storage.remove(KEYS.pending);
          lastError = "That sign-in request is no longer valid. Try again.";
          return;
        }
        await sleep(2000);
        continue;
      }

      if (result?.status === "approved") {
        // Exchanged HERE, in the same loop that claimed it: the custom token is single-use and
        // already spent as far as the service is concerned, so handing it anywhere else adds a
        // hop where it can be lost with no way to ask for another.
        const tokens = await exchangeCustomToken(
          result.apiKey,
          result.customToken,
        );
        teardown();
        await storage.set({
          [KEYS.session]: {
            ...tokens,
            uid: result.uid,
            email: result.email ?? "",
            apiKey: result.apiKey,
            projectId: result.projectId,
          },
          [KEYS.schema]: SCHEMA_VERSION,
          [KEYS.label]: pending.label,
        });
        await storage.remove(KEYS.pending);
        lastError = "";
        await reconcile();
        return;
      }

      await sleep(
        result?.status === "slow_down" ? (result.interval ?? 4) * 1000 : 2000,
      );
    }
  }

  async function refreshOwnBlocklist() {
    const store = await storage.get(KEYS.blocklist);
    ownBlocklistCache = Array.isArray(store[KEYS.blocklist])
      ? store[KEYS.blocklist]
      : [];
  }

  /**
   * Write the row on every workspace this browser is offered to.
   *
   * A DENIED workspace is dropped from the list rather than retried, and rather than being allowed
   * to fail the whole beat. A browser has no removal event, so a 403 on its own row IS the news
   * that it was thrown off. Scoping the reaction to that one workspace is what stops a single
   * revocation taking this browser off the others — the exact bug that once made a temporary
   * revocation permanent.
   */
  async function beat(idToken, session, id) {
    if (ships.length === 0) return;
    const live = {
      label: id.label,
      agentString: id.agentString,
      extensionVersion: id.extensionVersion,
      lastSeenAt: Date.now(),
      tabCount: lumi ? lumi.statusSnapshot().tabCount : 0,
    };
    const { removed, failed } = await syncShips(
      idToken,
      session.projectId,
      ships,
      id.browserId,
      id,
      session.uid,
      live,
    );
    if (removed.length) {
      ships = ships.filter((s) => !removed.includes(s));
      await storage.set({ [KEYS.ships]: ships });
      lastError = `Removed from ${removed.length} workspace${removed.length === 1 ? "" : "s"}.`;
    }
    if (failed.length) lastError = failed[0].message;
  }

  /**
   * Reconcile everything, once a minute and after every change.
   *
   * Deliberately one function rather than three timers. The refresh, the socket and the heartbeat
   * all depend on the same question — is there a live session — and separate schedules meant three
   * different answers to it could be in flight at once.
   */
  async function reconcile() {
    // The eviction backstop. If the worker was killed mid-handshake, the loop is gone but the
    // handshake is not — it is in storage — so the alarm re-enters it. Costs latency, never the
    // login. Deliberately not awaited: it can run for ten minutes.
    void pollPending();

    const id = await identity();
    await refreshPublicSession();
    const session = await loadSession(storage);
    if (!session) {
      teardown();
      return;
    }

    const store = await storage.get(KEYS.ships);
    ships = Array.isArray(store[KEYS.ships]) ? store[KEYS.ships] : [];

    // Refreshes if it is within five minutes of expiry, and returns null only when the session is
    // genuinely dead — a transient failure keeps the old token, because signing somebody out
    // because their train went into a tunnel is worse than one failed request.
    const idToken = await getIdToken(storage, {
      onSignedOut: (message) => {
        lastError = message;
        teardown();
      },
    });
    if (!idToken) {
      teardown();
      return;
    }

    if (!lumi) {
      lumi = new LumiConnection(id, {
        WebSocketCtor: deps.WebSocketCtor,
        makeExecutor: (pushStatus, label) => new Executor(pushStatus, label),
        mintTicket: async () => {
          const token = await getIdToken(storage);
          if (!token) {
            const err = new Error("Signed out.");
            err.fatal = true;
            throw err;
          }
          return mintTicket(callFunction, id.endpoint, token, id.browserId);
        },
        ownBlocklist: () => ownBlocklistCache,
        effectiveBlocklist,
        isBlocked,
        onStateChange: () => {},
        log,
      });
      lumi.connect();
    }

    await refreshOwnBlocklist();
    await beat(idToken, session, id);
  }

  return {
    name: "lumi",
    reconcile,

    reconnectAll() {
      lumi?.reconnect();
    },

    onDetach(source, reason) {
      // Only tabs this transport owns — the bridge transport is offered the same event and applies
      // the same test to its own tabs.
      if (source?.tabId != null && lumi?.ownsTab(source.tabId))
        lumi.routeDetach(source, reason);
    },

    onTabRemoved(tabId) {
      if (lumi?.ownsTab(tabId)) lumi.routeTabRemoved(tabId);
    },

    status() {
      return {
        lumi: lumi ? lumi.statusSnapshot() : null,
        session: publicSession,
        ships,
        lastError,
      };
    },

    onMessage(msg) {
      if (!msg || !MINE.has(msg.type)) return undefined; // not mine — see registry.onMessage

      if (msg.type === "beginLogin") {
        return storage.set({ [KEYS.pending]: msg.pending }).then(() => {
          void pollPending();
          return { ok: true };
        });
      }
      if (msg.type === "cancelLogin") {
        return storage.remove(KEYS.pending).then(() => ({ ok: true }));
      }
      if (msg.type === "setSession") {
        // TEAR THE SOCKET DOWN FIRST. `reconcile()` only builds a connection when there is none, so
        // a session replaced in place — signing in as somebody else without signing out — would
        // leave the previous account's socket up, minting tickets for a uid nobody is looking at.
        teardown();
        return storage
          .set({ [KEYS.session]: msg.session, [KEYS.schema]: SCHEMA_VERSION })
          .then(reconcile)
          .then(() => ({ ok: true }));
      }
      if (msg.type === "setShips") {
        ships = Array.isArray(msg.ships) ? msg.ships : [];
        return storage
          .set({ [KEYS.ships]: ships })
          .then(reconcile)
          .then(() => ({ ok: true }));
      }
      if (msg.type === "setBlocklist") {
        return storage
          .set({ [KEYS.blocklist]: msg.blocklist ?? [] })
          .then(() => ({ ok: true }));
      }
      // signOut
      return clearSession(storage).then(() => {
        ships = [];
        publicSession = null;
        teardown();
        return { ok: true };
      });
    },

    teardown,
  };
}
