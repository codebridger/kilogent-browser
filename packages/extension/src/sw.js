// MV3 service worker. Two modes, one worker.
//
//   Lumi mode (the default)   one socket to Lumi's relay, authenticated by a ticket Crew mints
//                             per connection, serving every Ship this person lends the browser to.
//   Bridge mode (advanced)    the original: N sockets to bridges you run yourself, each with a
//                             static token typed into a form.
//
// BOTH AT ONCE IS SUPPORTED and costs nothing structurally, because `ConnectionManager` already
// reconciled a SET of connections against a stored list. Bridge mode is also our own dev loop and
// the reason this repo is worth open-sourcing — anybody can run the whole thing themselves — so it
// is kept working rather than tolerated.
//
// Keepalive, unchanged and still the make-or-break MV3 piece: every inbound WS frame fires a
// worker event and resets the ~30s idle timer, so the 20s app-level heartbeat is what keeps the
// worker resident. The 1-minute alarm is the revival backstop if it is ever evicted anyway, and
// all state is rebuilt from storage on cold start.
import { Executor } from "./executor.js";
import { ConnectionManager } from "./connection.js";
import { LumiConnection } from "./lumi-connection.js";
import { KEYS, SCHEMA_VERSION } from "./lumi-config.js";
import {
  callFunction,
  exchangeCustomToken,
  getIdToken,
  loadSession,
  clearSession,
} from "./lumi-auth.js";
import { mintTicket, syncShips } from "./lumi-api.js";
import { effectiveBlocklist, isBlocked } from "./lumi-blocklist.js";

const storage = chrome.storage.local;

const bridges = new ConnectionManager({
  WebSocketCtor: WebSocket,
  makeExecutor: (pushStatus, label) => new Executor(pushStatus, label),
  onStateChange: () => {},
  log: (...a) => console.log(...a),
});

/** The single Lumi connection, or null when signed out. One socket serves every Ship. */
let lumi = null;
/**
 * The owner's own blocked origins, read once per tick rather than per command — `isBlocked` runs
 * on a hot path.
 *
 * Declared UP HERE, above `tick()`'s only call site, rather than beside the function that
 * refreshes it. `tick()` runs at module scope and reaches its first `await` before this line would
 * otherwise execute; today that is fine, and it stops being fine the moment somebody adds a
 * synchronous early path to it, which would then hit a temporal-dead-zone ReferenceError inside a
 * service worker at start-up.
 */
let ownBlocklistCache = [];
/** Ship ids this browser is offered to. Mirrored here so the heartbeat need not re-read storage. */
let lumiShips = [];
let lastError = "";

// ── top-level registration (re-runs on every cold start) ──────────────────────
chrome.alarms.create("keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive") tick();
});
chrome.runtime.onStartup.addListener(tick);
chrome.runtime.onInstalled.addListener(tick);
chrome.debugger.onDetach.addListener((source, reason) => route("onDetach", source, reason));
chrome.tabs.onRemoved.addListener((tabId) => route("onTabRemoved", tabId));

function route(kind, a, b) {
  if (kind === "onDetach") {
    if (a?.tabId != null && lumi?.ownsTab(a.tabId)) return lumi.routeDetach(a, b);
    return bridges.onDetach(a, b);
  }
  if (lumi?.ownsTab(a)) return lumi.routeTabRemoved(a);
  return bridges.onTabRemoved(a);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;
  const handlers = {
    getStatus: async () => ({
      bridges: bridges.statusSnapshot().profiles,
      lumi: lumi ? lumi.statusSnapshot() : null,
      session: await publicSession(),
      ships: lumiShips,
      lastError,
    }),
    saveProfiles: async () => {
      await storage.set({ profiles: msg.profiles });
      await reconcileBridges();
      return { ok: true };
    },
    reconnect: async () => {
      bridges.reconnectAll();
      lumi?.reconnect();
      return { ok: true };
    },
    /**
     * Begin a device handshake. THE WORKER POLLS, NOT THE POPUP.
     *
     * This was the other way round and could never have worked: Chrome closes an extension popup
     * the moment it loses focus, and the very next thing sign-in does is open the approval tab —
     * which moves focus. So the popup that owned the polling loop was guaranteed to be destroyed
     * about a millisecond after starting it. The approval would land on the web page and the
     * extension would never collect the session.
     *
     * The original objection to putting it here — a worker cannot be trusted to stay alive for a
     * ten-minute human round-trip — is real and is answered by keeping NO state in memory. The
     * handshake lives in storage, the loop below is just an optimisation for the common case, and
     * the one-minute alarm re-enters it if the worker was evicted. Eviction costs latency, not the
     * login.
     */
    beginLogin: async () => {
      await storage.set({ [KEYS.pending]: msg.pending });
      pollPending();
      return { ok: true };
    },
    cancelLogin: async () => {
      await storage.remove(KEYS.pending);
      return { ok: true };
    },
    setSession: async () => {
      // TEAR THE SOCKET DOWN FIRST. `tick()` only builds a connection when there is none, so a
      // session replaced in place — signing in as somebody else without signing out — would leave
      // the previous account's socket up, minting tickets for a uid nobody is looking at any more.
      teardownLumi();
      await storage.set({ [KEYS.session]: msg.session, [KEYS.schema]: SCHEMA_VERSION });
      await tick();
      return { ok: true };
    },
    setShips: async () => {
      lumiShips = Array.isArray(msg.ships) ? msg.ships : [];
      await storage.set({ [KEYS.ships]: lumiShips });
      await tick();
      return { ok: true };
    },
    setBlocklist: async () => {
      await storage.set({ [KEYS.blocklist]: msg.blocklist ?? [] });
      return { ok: true };
    },
    signOut: async () => {
      await clearSession(storage);
      lumiShips = [];
      teardownLumi();
      return { ok: true };
    },
  };
  const fn = handlers[msg.type];
  if (!fn) return false;
  fn().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

tick();

// ── state ─────────────────────────────────────────────────────────────────────

/** What the popup may see. Never the tokens — it has no use for them and every leak has a path. */
async function publicSession() {
  const s = await loadSession(storage);
  return s ? { uid: s.uid, email: s.email ?? "", projectId: s.projectId } : null;
}

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

async function reconcileBridges() {
  bridges.reconcile(await loadProfiles());
}

/** This machine's browser id — minted once per Chrome profile and kept forever. It names a
 *  MACHINE, not a membership, which is why one id is correct across every Ship. */
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
    agentString: navigator.userAgent.slice(0, 400),
    extensionVersion: chrome.runtime.getManifest().version,
    endpoint: store[KEYS.endpoint] || "",
  };
}

function teardownLumi() {
  lumi?.teardown();
  lumi = null;
}

// ── the tick ──────────────────────────────────────────────────────────────────

/**
 * Reconcile everything, once a minute and after every change.
 *
 * Deliberately one function rather than three timers. The refresh, the socket and the heartbeat
 * all depend on the same question — is there a live session — and separate schedules meant three
 * different answers to it could be in flight at once.
 */
async function tick() {
  await reconcileBridges();

  // The eviction backstop. If the worker was killed mid-handshake, the loop is gone but the
  // handshake is not — it is in storage — so the alarm re-enters it. Costs latency, never the login.
  pollPending();

  const id = await identity();
  const session = await loadSession(storage);
  if (!session) {
    teardownLumi();
    return;
  }

  const store = await storage.get(KEYS.ships);
  lumiShips = Array.isArray(store[KEYS.ships]) ? store[KEYS.ships] : [];

  // Refreshes if it is within five minutes of expiry, and returns null only when the session is
  // genuinely dead — a transient failure keeps the old token, because signing somebody out
  // because their train went into a tunnel is worse than one failed request.
  const idToken = await getIdToken(storage, {
    onSignedOut: (message) => {
      lastError = message;
      teardownLumi();
    },
  });
  if (!idToken) {
    teardownLumi();
    return;
  }

  if (!lumi) {
    lumi = new LumiConnection(id, {
      WebSocketCtor: WebSocket,
      makeExecutor: (pushStatus, label) => new Executor(pushStatus, label),
      mintTicket: async () => {
        const token = await getIdToken(storage);
        if (!token) {
          const err = new Error("Signed out of Lumi.");
          err.fatal = true;
          throw err;
        }
        return mintTicket(callFunction, id.endpoint, token, id.browserId);
      },
      ownBlocklist: () => ownBlocklistCache,
      effectiveBlocklist,
      isBlocked,
      onStateChange: () => {},
      log: (...a) => console.log(...a),
    });
    lumi.connect();
  }

  await refreshOwnBlocklist();
  await beat(idToken, session, id);
}

/**
 * Poll an in-flight handshake until it is approved, expires, or is cancelled.
 *
 * Re-entrancy is guarded by `polling` rather than by a lock, because the two entry points — the
 * popup starting a login, and the alarm re-entering after an eviction — can genuinely coincide,
 * and two loops would burn the server's `slow_down` budget against each other.
 *
 * A failed poll is SWALLOWED and retried, except for the terminal statuses. The commonest reason a
 * single poll fails is a network blip, and throwing away a code the human is still typing because
 * of one is the worst possible answer.
 */
let polling = false;
async function pollPending() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const store = await storage.get(KEYS.pending);
      const pending = store[KEYS.pending];
      if (!pending) return;
      if (Date.now() > pending.expiresAt) {
        await storage.remove(KEYS.pending);
        lastError = "That sign-in code expired before it was approved. Try again.";
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
        // already spent as far as Crew is concerned, so handing it anywhere else adds a hop where
        // it can be lost with no way to ask for another.
        const tokens = await exchangeCustomToken(result.apiKey, result.customToken);
        teardownLumi();
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
        await tick();
        return;
      }

      await sleep(result?.status === "slow_down" ? (result.interval ?? 4) * 1000 : 2000);
    }
  } finally {
    polling = false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function refreshOwnBlocklist() {
  const store = await storage.get(KEYS.blocklist);
  ownBlocklistCache = Array.isArray(store[KEYS.blocklist]) ? store[KEYS.blocklist] : [];
}

/**
 * Write the row on every Ship this browser is offered to.
 *
 * A DENIED Ship is dropped from the list rather than retried, and rather than being allowed to
 * fail the whole beat. That is the §15.30 inference: a browser has no removal event, so a 403 on
 * its own row IS the news that it was thrown off. Scoping the reaction to that one Ship is what
 * stops a single revocation taking this browser off the other two — the exact bug that made a
 * temporary revocation permanent for daemons.
 */
async function beat(idToken, session, id) {
  if (lumiShips.length === 0) return;
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
    lumiShips,
    id.browserId,
    id,
    session.uid,
    live,
  );
  if (removed.length) {
    lumiShips = lumiShips.filter((s) => !removed.includes(s));
    await storage.set({ [KEYS.ships]: lumiShips });
    lastError = `Removed from ${removed.length} workspace${removed.length === 1 ? "" : "s"}.`;
  }
  if (failed.length) lastError = failed[0].message;
}
