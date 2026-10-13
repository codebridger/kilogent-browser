// The `kilogent` transport — a hosted service, and the worked example of a second one.
//
// One socket to Kilogent's relay, authenticated by a short-lived ticket the service mints per
// connection. The browser is ONE account-level record with a name (PRFAQ-001): which agents may
// use it is decided in Kilogent, per link, never here. It sits beside the
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
import { KilogentConnection } from "./connection.js";
import { KEYS, SCHEMA_VERSION } from "./config.js";
import {
  authBase,
  callFunction,
  exchangeCustomToken,
  getIdToken,
  loadSession,
  clearSession,
} from "./auth.js";
import {
  mintTicket,
  registerBrowser,
  renameBrowser,
  suggestBrowserName,
  browserHeartbeat,
  setBrowserPaused,
  signOutBrowser,
} from "./api.js";
import { effectiveBlocklist, isAllowed, isBlocked } from "./blocklist.js";

/** The contract's heartbeat period. A browser counts as online for 90 s after its last beat. */
const HEARTBEAT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The Kilogent web app's origin, from the sign-in page it sent us to. */
function appOriginOf(url) {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}

/** The popup messages only this transport can answer. `getStatus` and `reconnect` are NOT here —
 *  see the file header. */
const MINE = new Set([
  "beginLogin",
  "cancelLogin",
  "setSession",
  "setName",
  "setPaused",
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
export function createKilogentTransport(deps) {
  const storage = deps.storage;
  const log = deps.log || (() => {});

  /** The single connection, or null when signed out. One socket serves every workspace. */
  let kilogent = null;
  /**
   * The owner's own blocked origins, read once per tick rather than per command — `isBlocked` runs
   * on a hot path.
   */
  let ownBlocklistCache = [];
  /**
   * PAUSE ALL AGENTS, mirrored from storage so the command path can ask synchronously. Read by
   * `KilogentConnection.handleCmd` before every command — a paused browser refuses locally, whether
   * or not the server has heard.
   */
  let paused = false;
  /** The browser's own record, as the popup needs it. See `refreshBrowserState`. */
  let browser = { name: "", registered: false, needsName: false, needsRename: false, paused: false };
  let lastError = "";
  /** The 30 s heartbeat, alive exactly while the socket is. */
  let beatTimer = null;
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
      name: store[KEYS.label] || "",
      label: store[KEYS.label] || "This browser",
      agentString: (deps.userAgent || "").slice(0, 400),
      extensionVersion: deps.extensionVersion || "",
      endpoint: store[KEYS.endpoint] || "",
    };
  }

  function teardown() {
    kilogent?.teardown();
    kilogent = null;
    if (beatTimer) clearInterval(beatTimer);
    beatTimer = null;
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
      log("[kilogent] sign-in polling stopped:", err);
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
        // The code is SPENT the moment the server says approved, so a failure here cannot be
        // retried: drop the handshake and say so, rather than show "Waiting for approval…" until
        // it expires.
        let tokens;
        try {
          tokens = await exchangeCustomToken(
            result.apiKey,
            result.customToken,
            authBase(pending.endpoint, result.authEmulatorOrigin),
          );
        } catch (e) {
          await storage.remove(KEYS.pending);
          lastError = `Approved, but signing in could not finish: ${e?.message || e}. Try again.`;
          return;
        }
        teardown();
        await storage.set({
          [KEYS.session]: {
            ...tokens,
            uid: result.uid,
            email: result.email ?? "",
            apiKey: result.apiKey,
            projectId: result.projectId,
            // Kept so a refresh goes to the same place. Ignored unless the endpoint is local.
            ...(result.authEmulatorOrigin ? { authEmulatorOrigin: result.authEmulatorOrigin } : {}),
            // Signed in with names required. An install without this mark is an UPDATE of an
            // older version; see `adoptLegacyName`.
            flow: 2,
          },
          [KEYS.schema]: SCHEMA_VERSION,
          ...(appOriginOf(pending.verificationUrl)
            ? { [KEYS.appOrigin]: appOriginOf(pending.verificationUrl) }
            : {}),
        });
        // A NEW SIGN-IN NAMES THE BROWSER AGAIN. Whatever was accepted before belonged to whichever
        // account was signed in then; the popup asks for a name for this one, prefilled.
        await storage.remove([KEYS.pending, KEYS.registered, KEYS.ships]);
        lastError = "";
        await reconcile({ forceBeat: true });
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
   * The server's last word on this browser, as cached in storage — or null when that word was for
   * another account, another endpoint or another browserId. Used ONLY when the server cannot be
   * asked right now: a network blip must not drop a working socket.
   */
  function cachedRecord(reg, session, id) {
    const ok =
      !!reg &&
      reg.uid === session.uid &&
      reg.browserId === id.browserId &&
      (reg.endpoint || "") === (id.endpoint || "") &&
      !!reg.name;
    return ok ? reg : null;
  }

  /** Recompute what the popup shows about this browser, from storage. */
  async function refreshBrowserState(session, id) {
    const store = await storage.get([KEYS.registered, KEYS.paused]);
    paused = store[KEYS.paused] === true;
    const reg = session ? cachedRecord(store[KEYS.registered], session, id) : null;
    browser = {
      name: reg?.name || "",
      registered: !!reg,
      // BLOCKING: no record on this account, so no socket until the popup names it.
      needsName: !!session && !reg,
      // A NUDGE: the record exists and works, but its name was made up for it (migration suffix,
      // or a fallback). The popup asks for a better one; nothing waits for the answer.
      needsRename: !!reg?.needsRename,
      paused,
    };
  }

  /** Cache the server's view of this browser's record. */
  async function remember(session, id, name, needsRename) {
    await storage.set({
      [KEYS.label]: name,
      [KEYS.registered]: {
        uid: session.uid,
        browserId: id.browserId,
        endpoint: id.endpoint || "",
        name,
        needsRename: !!needsRename,
      },
    });
  }

  /** A browserId another account already owns: mint a fresh one, as the contract asks. */
  async function freshBrowserId() {
    teardown(); // a socket, if any, was for the old id
    await storage.remove([KEYS.browserId, KEYS.registered]);
    return identity();
  }

  /**
   * Register, retrying ONCE with a fresh browserId if this one belongs to another account (a
   * profile copied between people, or a reused test profile).
   */
  async function registerWithRetry(idToken, id, name) {
    try {
      await registerBrowser(callFunction, id.endpoint, idToken, { ...id, name });
      return id;
    } catch (e) {
      if (e?.code !== "browser_taken") throw e;
      const fresh = await freshBrowserId();
      await registerBrowser(callFunction, fresh.endpoint, idToken, { ...fresh, name });
      return fresh;
    }
  }

  /**
   * AN EXISTING INSTALL, UPDATED, that the server's migration never saw (it was created after the
   * migration ran). It must KEEP WORKING, so it is never sent to a blocking name step: it registers
   * its old name, or the server's suggestion when that is missing or taken, and the popup then
   * nudges for a better name.
   *
   * "This browser" was the old default when nobody typed anything, so it does not count as a name.
   */
  async function adoptLegacyName(idToken, session, id) {
    const legacy = id.name && id.name !== "This browser" ? id.name : "";
    let name = legacy;
    try {
      if (!name) name = (await suggestBrowserName(callFunction, id.endpoint, idToken, id.agentString)) || "Chrome";
      let used = id;
      try {
        used = await registerWithRetry(idToken, id, name);
      } catch (e) {
        if (e?.code !== "name_taken" || !e.suggestion) throw e;
        name = e.suggestion;
        used = await registerWithRetry(idToken, id, name);
      }
      await remember(session, used, name, name !== legacy);
      return true;
    } catch (e) {
      lastError = String(e?.message || e);
      return false;
    }
  }

  /** When the last heartbeat went out, so the alarm and the 30 s timer do not double up. */
  let lastBeat = { at: 0, state: "unknown" };

  /**
   * ONE heartbeat for this browser — there used to be one per workspace it was offered to.
   * Answers "registered" | "unregistered" | "unknown" (the server could not be asked).
   *
   * Also where the pause CONVERGES. A local change is pushed with `setBrowserPaused` and marked
   * dirty until the server acknowledges it; with nothing dirty, the server's answer wins, which is
   * how "Turn off all" on My browsers reaches this switch.
   */
  async function beat(idToken, session, id, { force = false } = {}) {
    if (!force && Date.now() - lastBeat.at < HEARTBEAT_MS - 5000) return lastBeat.state;
    const store = await storage.get([KEYS.registered, KEYS.pauseDirty]);

    if (store[KEYS.pauseDirty] && cachedRecord(store[KEYS.registered], session, id)) {
      try {
        await setBrowserPaused(callFunction, id.endpoint, idToken, id.browserId, paused);
        await storage.remove(KEYS.pauseDirty);
      } catch (e) {
        lastError = `Paused here, but Kilogent has not heard yet: ${e?.message || e}`;
      }
    }

    let answer;
    try {
      answer = await browserHeartbeat(callFunction, id.endpoint, idToken, {
        browserId: id.browserId,
        tabCount: kilogent ? kilogent.statusSnapshot().tabCount : 0,
        extensionVersion: id.extensionVersion,
      });
    } catch (e) {
      if (e?.code === "browser_not_registered") answer = { registered: false };
      else {
        lastError = String(e?.message || e);
        return (lastBeat = { at: Date.now(), state: "unknown" }).state;
      }
    }

    if (!answer?.registered) {
      // Never named on this account, or removed on My browsers.
      await storage.remove(KEYS.registered);
      return (lastBeat = { at: Date.now(), state: "unregistered" }).state;
    }
    const cached = cachedRecord(store[KEYS.registered], session, id);
    await remember(session, id, answer.name || cached?.name || id.name, answer.needsRename);
    const stillDirty = (await storage.get(KEYS.pauseDirty))[KEYS.pauseDirty];
    if (!stillDirty && typeof answer.paused === "boolean" && answer.paused !== paused) {
      paused = answer.paused;
      await storage.set({ [KEYS.paused]: paused });
    }
    lastError = "";
    return (lastBeat = { at: Date.now(), state: "registered" }).state;
  }

  /**
   * Reconcile everything, once a minute and after every change.
   *
   * Deliberately one function rather than three timers. The refresh, the socket and the heartbeat
   * all depend on the same question — is there a live session — and separate schedules meant three
   * different answers to it could be in flight at once.
   */
  async function reconcile({ forceBeat = false } = {}) {
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

    // The workspace list from before PRFAQ-001. Nothing reads it any more.
    await storage.remove(KEYS.ships);
    await refreshBrowserState(session, id);

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

    let state = await beat(idToken, session, id, { force: forceBeat });
    if (state === "unregistered" && session.flow !== 2) {
      // An updated old install the migration did not cover. It keeps working — see adoptLegacyName.
      if (await adoptLegacyName(idToken, session, id)) state = await beat(idToken, session, await identity(), { force: true });
    }
    const cached = cachedRecord((await storage.get(KEYS.registered))[KEYS.registered], session, id);
    await refreshBrowserState(session, await identity());
    if (state === "unregistered" || (state === "unknown" && !cached)) {
      // NO RECORD, NO SOCKET (the contract). The popup asks for a name; `setName` comes back here.
      teardown();
      return;
    }

    if (!kilogent) {
      kilogent = new KilogentConnection(id, {
        WebSocketCtor: deps.WebSocketCtor,
        // The policy core asks, and the arming core awaits. Both arrows close over `kilogent`,
        // which is still being assigned on this very line — safe because neither is CALLED until a
        // command runs, long after the constructor has returned.
        makeExecutor: (pushStatus, label) =>
          new Executor(pushStatus, label, {
            allowUrl: (url, ctx) => kilogent.allowUrl(url, ctx),
            onAttached: (chromeTabId) => kilogent.armTab(chromeTabId),
          }),
        mintTicket: async () => {
          const token = await getIdToken(storage);
          if (!token) {
            const err = new Error("Signed out.");
            err.fatal = true;
            throw err;
          }
          return mintTicket(callFunction, id.endpoint, token, id.browserId);
        },
        // Needed for the SESSION POLICY, which is persisted now: an in-memory blocklist is gone at
        // the next worker eviction, and the relay does not re-send it because its session is still
        // open. See `restoreSessions`.
        storage,
        // PAUSE ALL AGENTS, enforced here as well as on the server. Read per command, so the
        // switch takes effect on the very next one.
        isPaused: () => paused,
        ownBlocklist: () => ownBlocklistCache,
        effectiveBlocklist,
        isBlocked,
        isAllowed,
        onStateChange: () => {},
        log,
      });
      kilogent.connect();
    }

    // ONE heartbeat every 30 s while the socket is up. The alarm alone is once a minute, and the
    // server reads a browser as offline 90 s after its last beat — too close for one missed alarm.
    beatTimer ??= setInterval(() => void reconcile().catch(() => {}), HEARTBEAT_MS);

    await refreshOwnBlocklist();
  }

  /**
   * Name (or rename) this browser. Answers `{ok, name}` or `{ok:false, code, suggestion, message}`
   * so the popup can show the server's own refusal with its suggestion.
   */
  async function setName(raw) {
    const name = String(raw ?? "").trim();
    const session = await loadSession(storage);
    const idToken = session ? await getIdToken(storage) : null;
    if (!idToken) return { ok: false, code: "", suggestion: "", message: "Signed out." };
    let id = await identity();
    const cached = cachedRecord((await storage.get(KEYS.registered))[KEYS.registered], session, id);
    try {
      if (cached) await renameBrowser(callFunction, id.endpoint, idToken, id.browserId, name);
      else id = await registerWithRetry(idToken, id, name);
    } catch (e) {
      return {
        ok: false,
        code: e?.code || "",
        suggestion: e?.suggestion || "",
        message: String(e?.message || e),
      };
    }
    await remember(session, id, name, false);
    lastError = "";
    // FORCED: the throttled answer from a few seconds ago is "unregistered", and reusing it left a
    // freshly named browser offline until the next alarm — up to a minute in which an agent run
    // was told the browser was not there. A real local stack caught it.
    await reconcile({ forceBeat: true }); // opens the socket if this was the first name
    return { ok: true, name };
  }

  /** Best effort, bounded: sign-out must not hang on a slow or unreachable server. */
  async function tellServerSignedOut() {
    try {
      const idToken = await getIdToken(storage);
      if (!idToken) return;
      const id = await identity();
      await Promise.race([
        signOutBrowser(callFunction, id.endpoint, idToken, id.browserId),
        sleep(3000),
      ]);
    } catch {
      /* shows as offline instead of signed out — acceptable */
    }
  }

  /** PAUSE ALL AGENTS. Local first — it holds even if the server call below fails. */
  async function setPausedLocal(next) {
    paused = !!next;
    await storage.set({ [KEYS.paused]: paused, [KEYS.pauseDirty]: true });
    browser = { ...browser, paused };
    // Best effort now; `beat` keeps retrying while it is dirty.
    void reconcile({ forceBeat: true }).catch(() => {});
    return { ok: true, paused };
  }

  return {
    name: "kilogent",
    reconcile,

    reconnectAll() {
      kilogent?.reconnect();
    },

    onDetach(source, reason) {
      // Only tabs this transport owns — the bridge transport is offered the same event and applies
      // the same test to its own tabs.
      if (source?.tabId != null && kilogent?.ownsTab(source.tabId))
        kilogent.routeDetach(source, reason);
    },

    /**
     * A paused request, on its way to a verdict.
     *
     * NOT gated on `ownsTab` the way detach and tab-close are, and the difference is the point:
     * those two are NOTIFICATIONS, so ignoring one that is not ours costs nothing. This is a
     * QUESTION the browser is holding a page open for. `Fetch` is only ever enabled on tabs this
     * transport armed, so an event naming a tab it no longer recognises means the worker was
     * evicted and lost its index — and the handler refuses it rather than leaving the tab hanging.
     */
    onDebuggerEvent(source, method, params) {
      void kilogent?.onDebuggerEvent(source, method, params);
    },

    onTabRemoved(tabId) {
      if (kilogent?.ownsTab(tabId)) kilogent.routeTabRemoved(tabId);
    },

    status() {
      return {
        kilogent: kilogent ? kilogent.statusSnapshot() : null,
        session: publicSession,
        browser,
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
      if (msg.type === "setName") return setName(msg.name);
      if (msg.type === "setPaused") return setPausedLocal(msg.paused);
      if (msg.type === "setBlocklist") {
        return storage
          .set({ [KEYS.blocklist]: msg.blocklist ?? [] })
          .then(() => ({ ok: true }));
      }
      // signOut — ONLY disconnects (the founder's call): the record and its links stay, and
      // signing in again brings the browser back. Removing it is a deliberate act on My browsers.
      return tellServerSignedOut().then(() => clearSession(storage)).then(() => {
        publicSession = null;
        browser = { ...browser, name: "", registered: false, needsName: false, needsRename: false };
        teardown();
        return { ok: true };
      });
    },

    teardown,
  };
}
