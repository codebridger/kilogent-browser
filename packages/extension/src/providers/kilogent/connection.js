// One live socket to the Kilogent relay, speaking protocol v2.
//
// The sibling of `Connection` in connection.js, and the difference is entirely in the handshake
// and the credential. That one dials a bridge somebody runs themselves and authenticates a STATIC
// token typed into a form; this one dials Kilogent's relay and authenticates a TICKET that Crew mints
// per socket and that expires in ten minutes. What is deliberately identical is everything after
// `welcome` — `cmd`/`res`/`status`/`ping` — so `Executor` never learns which server it is talking
// to, and the CDP layer is shared whole.
//
// THE TICKET IS FETCHED, NOT STORED, and that shapes the reconnect. A ticket is good for one
// socket and ten minutes, so every connect mints a fresh one; there is nothing here worth stealing
// at rest, and a laptop that slept through the weekend wakes up and simply asks for another.
//
// Dependency-injected (`WebSocketCtor`, `makeExecutor`, `mintTicket`) exactly as `Connection` is,
// so `scripts/kilogent-contract-harness.mjs` can drive it in Node against the relay's REAL protocol
// validator with no Chrome present.

const DEFAULT_HEARTBEAT_MS = 20000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;

import { KEYS } from "./config.js";

/**
 * A refusal sentence with its code at the end, e.g. "… in Kilogent. [not_allowed]".
 *
 * IN THE TEXT, because the relay hands the agent `error.message` and drops `error.code` — and
 * Kilogent branches on the code to log the call as refused and to put it in the owner's words.
 */
export function withCode(code, message) {
  return `${message} [${code}]`;
}

export class KilogentConnection {
  /**
   * @param {{browserId:string,label:string,agentString?:string,extensionVersion?:string}} identity
   * @param {{WebSocketCtor:typeof WebSocket, makeExecutor:Function, mintTicket:()=>Promise<{ticket:string,relayUrl:string}>, ownBlocklist:()=>string[], onStateChange?:Function, log?:Function}} deps
   */
  constructor(identity, deps) {
    this.identity = identity;
    this.deps = deps;
    this.socket = null;
    this.heartbeatTimer = null;
    this.backoff = 0;
    /** init | connecting | connected | signed_out | unauthorized | disconnected */
    this.connState = "init";
    this.closed = false;
    this.ownerUid = null;
    /** Ship blocklists, per open session. Unioned with the owner's at enforcement time. */
    this.sessionBlocklists = new Map();
    /** Allow lists, per open session — the sites the link names. Absent or empty = any site. */
    this.sessionAllowlists = new Map();
    /** sessionId -> {count, last} of refusals this session has had. See `refusalCountFor`. */
    this.refusals = new Map();
    this.executor = deps.makeExecutor(
      (attached, tabId, url, reason) => this.pushStatus(attached, tabId, url, reason),
      identity.label || "Kilogent",
    );
  }

  log(...args) {
    this.deps.log?.(`[kilogent ${this.identity.label || this.identity.browserId}]`, ...args);
  }

  setState(state) {
    this.connState = state;
    this.deps.onStateChange?.();
  }

  ownsTab(tabId) {
    return this.executor.tabIndex.has(tabId);
  }
  routeDetach(source, reason) {
    this.executor.onDetach(source, reason);
  }
  routeTabRemoved(tabId) {
    this.executor.onTabRemoved(tabId);
  }

  /** The effective policy for a session: the Ship's list ∪ this machine's own. */
  /**
   * MAY THIS TAB BE WHERE IT IS? — `Executor`'s `allowUrl`, answered from this connection's lists.
   *
   * The second of the two doors, and the one that closes the gap: the argument check below can only
   * judge a URL a tool NAMED, and a click names none. Core asks this after every action with
   * wherever the tab actually ended up, so a link, a 30x and a meta-refresh are all covered.
   *
   * Returns the SENTENCE rather than `false`, because core hands a string straight to the agent and
   * this transport should keep its own wording.
   */
  allowUrl(url, ctx) {
    // UNKNOWN REFUSES. Not knowing the policy is not the same as the policy being empty — see
    // `knowsSession`. This is the arm that used to say yes to everything after a worker restart.
    if (!this.knowsSession(ctx?.sessionId)) return this.unknownPolicyRefusal();
    const refused = this.refusalFor(url, ctx?.sessionId);
    if (!refused) return true;
    // Noted so the command running now answers as an ERROR. Core hands this sentence back as a
    // normal result, which Kilogent's activity log would record as a successful call.
    this.noteRefusal(ctx?.sessionId, refused);
    return refused.message;
  }

  /**
   * Why this URL may not load in this session, or null if it may. ONE place for both lists, so the
   * three doors (the argument, `Fetch`, and `allowUrl`) cannot drift apart. The blocklist is asked
   * first: a site on both lists is blocked.
   */
  refusalFor(url, sessionId) {
    if (this.deps.isBlocked(url, this.blocklistFor(sessionId))) {
      return {
        code: "blocked",
        message: withCode(
          "blocked",
          "That address is blocked on this browser. Ask its owner, or a captain — you cannot change this yourself.",
        ),
      };
    }
    if (this.deps.isAllowed && !this.deps.isAllowed(url, this.sessionAllowlists.get(sessionId))) {
      return {
        code: "not_allowed",
        message: withCode(
          "not_allowed",
          "That site is not one this agent was given on this browser. Ask the browser's owner to add it to the link in Kilogent.",
        ),
      };
    }
    return null;
  }

  /**
   * Arm request interception on a tab, awaited by core before the first command runs.
   *
   * DOCUMENT REQUESTS ONLY. Unscoped interception pauses every image, font and XHR — 30-300 per
   * ordinary page — and each is a round trip through this single service worker, which is also
   * carrying the 20-second heartbeat this connection dies without. Scoped to documents it is one
   * pause per navigation plus one per redirect hop.
   *
   * This is what makes the blocklist PREVENT rather than merely refuse: `Fetch.requestPaused` fires
   * before the socket opens, so a blocked origin receives no connection, no TLS handshake and none
   * of the person's cookies.
   */
  /**
   * How many navigations this session has had refused, so a command can say so.
   *
   * THE TWO HALVES CANCELLED EACH OTHER OUT WITHOUT THIS, and a live agent found it. `Fetch` stops
   * the navigation, so the tab NEVER MOVES — and `allowUrl`, asked afterwards where the tab is,
   * sees the page it was already on, which is allowed, and permits the command. Prevention worked
   * perfectly and the agent was told nothing: it clicked a link, got `Clicked e41`, read the page,
   * found itself still on the search results, and reported that it could not tell whether the
   * blocklist had fired or something else had broken.
   *
   * A counter rather than a flag, and keyed by SESSION rather than globally: two sessions run
   * concurrently on one connection, and a block in one must not refuse the other's command.
   *
   * BOTH DOORS COUNT: a navigation `Fetch` failed, and a place `allowUrl` refused after an action.
   * The last refusal is kept so the command can answer with ITS reason (`blocked` or
   * `not_allowed`) rather than a generic one.
   */
  refusalCountFor(sessionId) {
    return this.refusals.get(sessionId)?.count ?? 0;
  }

  /**
   * Where this session's active tab is right now, or null.
   *
   * READ LIVE, not from core's cached `rec.url`, which is stale after a click navigates. Asked of
   * the browser through `Page.getNavigationHistory`: no page script runs, and on Chrome's "blocked"
   * page it still names the address that was tried — which is where the action happened.
   */
  async pageUrlFor(sessionId) {
    const session = this.executor.sessions.get(sessionId);
    const rec = session?.activeTab ? session.tabs.get(session.activeTab) : null;
    if (!rec) return null;
    try {
      const h = await this.executor.sendCdp(rec.chromeTabId, "Page.getNavigationHistory", {});
      const url = h?.entries?.[h.currentIndex]?.url;
      return typeof url === "string" && url ? url : (rec.url ?? null);
    } catch {
      return rec.url ?? null;
    }
  }

  /**
   * Add `Page URL: <url>` to a result, so Kilogent's per-link activity log can say WHERE each action
   * happened (PRFAQ-001: "which sites the agent opened and what it did"). Best effort: a result
   * whose page cannot be read is sent as it was.
   */
  async withPageUrl(sessionId, result) {
    const url = await this.pageUrlFor(sessionId);
    if (!url || !result || !Array.isArray(result.content)) return result;
    return { ...result, content: [...result.content, { type: "text", text: `Page URL: ${url}` }] };
  }

  noteRefusal(sessionId, refusal) {
    if (sessionId == null) return;
    const prev = this.refusals.get(sessionId);
    this.refusals.set(sessionId, { count: (prev?.count ?? 0) + 1, last: refusal });
  }

  async armTab(chromeTabId) {
    await this.executor.sendCdp(chromeTabId, "Fetch.enable", {
      patterns: [{ requestStage: "Request", resourceType: "Document" }],
    });
  }

  /**
   * Answer a paused request.
   *
   * ⚠️ IT MUST NEVER TAKE THE TAB LOCK. The paused request is holding the page's load, and the lock
   * is held by whatever command caused the navigation — waiting for it waits for a load that is
   * waiting for this. `executor.sendCdp` is a bare `chrome.debugger.sendCommand` and takes no lock,
   * which is exactly why it is used here rather than any of the command helpers.
   *
   * ⚠️ UNKNOWN STATE FAILS THE REQUEST. `tabIndex` and `sessionBlocklists` live in memory, and MV3
   * evicts this worker whenever it likes; an event that wakes it back up finds both empty. Treating
   * "I do not recognise this tab" as "allow" is precisely the hole being closed, so it refuses — and
   * it must REFUSE rather than return, because a paused request nobody answers hangs the tab until
   * Chrome gives up on it.
   */
  async onDebuggerEvent(source, method, params) {
    if (method !== "Fetch.requestPaused") return;
    const tabId = source?.tabId;
    const requestId = params?.requestId;
    if (typeof tabId !== "number" || !requestId) return;

    const idx = this.executor.tabIndex.get(tabId);
    const url = params?.request?.url;
    const allowed =
      !!idx &&
      typeof url === "string" &&
      this.knowsSession(idx.sessionId) &&
      !this.refusalFor(url, idx.sessionId);

    try {
      if (allowed) {
        await this.executor.sendCdp(tabId, "Fetch.continueRequest", { requestId });
      } else {
        await this.executor.sendCdp(tabId, "Fetch.failRequest", {
          requestId,
          errorReason: "BlockedByClient",
        });
        this.deps.log?.("[kilogent] blocked a navigation", url ?? "(unknown)");
        // Recorded so the command that caused it can REPORT it. Without this the refusal is
        // invisible: the tab simply never moves, and every later check sees an allowed page.
        if (idx) {
          const why =
            (typeof url === "string" && this.knowsSession(idx.sessionId) && this.refusalFor(url, idx.sessionId)) ||
            { code: "blocked", message: this.unknownPolicyRefusal() };
          this.noteRefusal(idx.sessionId, why);
        }
      }
    } catch (e) {
      // The target detached between the pause and the answer. Nothing is left to answer to, and the
      // navigation died with it.
    }
  }

  /**
   * Do we actually KNOW this session's policy?
   *
   * The distinction `?? []` erased, and it is the whole bug. An empty list means "the Ship blocks
   * nothing"; a MISSING entry means "we have no idea what the Ship blocks". Treating the second as
   * the first is how a browser with a blocklist allowed everything: the worker restarts, this map is
   * empty, the relay does not re-send `session_open` because ITS session is still open — and every
   * check downstream asked an empty list and was told yes.
   */
  knowsSession(sessionId) {
    return this.sessionBlocklists.has(sessionId);
  }

  /** Absent or empty means "any site". Kept absent rather than [] so restore can tell them apart. */
  setAllowlist(sessionId, origins) {
    if (Array.isArray(origins) && origins.length > 0) this.sessionAllowlists.set(sessionId, origins);
    else this.sessionAllowlists.delete(sessionId);
  }

  blocklistFor(sessionId) {
    const ship = this.sessionBlocklists.get(sessionId) ?? [];
    return this.deps.effectiveBlocklist(ship, this.deps.ownBlocklist());
  }

  /** The refusal used wherever the policy is unknown. Fails CLOSED, on purpose. */
  unknownPolicyRefusal() {
    return withCode(
      "blocked",
      "This browser cannot confirm what it is allowed to open right now, so it refused. " +
        "Try again in a moment; if it keeps happening, ask its owner to reopen the browser.",
    );
  }

  /**
   * Restore persisted session policies, once, before anything is judged.
   *
   * Awaited by `handleCmd`, so a command that arrives while the worker is still warming up waits
   * rather than being judged against a map that is not filled in yet.
   */
  async restoreSessions() {
    try {
      const store = await this.deps.storage.get([KEYS.sessions, KEYS.sessionAllows]);
      const saved = store?.[KEYS.sessions];
      // Allow lists FIRST, so a session never becomes known (below) without its allow list —
      // that order is what keeps a restored session from briefly allowing every site.
      const allows = store?.[KEYS.sessionAllows];
      if (allows && typeof allows === "object") {
        for (const [sid, origins] of Object.entries(allows)) {
          if (!this.sessionAllowlists.has(sid) && Array.isArray(origins)) {
            this.sessionAllowlists.set(sid, origins);
          }
        }
      }
      if (saved && typeof saved === "object") {
        for (const [sid, origins] of Object.entries(saved)) {
          if (!this.sessionBlocklists.has(sid) && Array.isArray(origins)) {
            this.sessionBlocklists.set(sid, origins);
          }
        }
      }
    } catch (e) {
      // Storage unavailable. Everything stays unknown, which refuses rather than allows.
    }
  }

  /** Write the map back, so the next worker starts knowing what this one knew. */
  persistSessions() {
    const out = {};
    for (const [sid, origins] of this.sessionBlocklists) out[sid] = origins;
    const allows = {};
    for (const [sid, origins] of this.sessionAllowlists) allows[sid] = origins;
    void this.deps.storage
      .set({ [KEYS.sessions]: out, [KEYS.sessionAllows]: allows })
      .catch(() => {});
  }

  async connect() {
    if (this.closed) return;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.setState("connecting");

    // MINTED PER SOCKET. A failure here is usually "signed out", which is terminal and must not be
    // retried on a backoff — a worker asking a signed-out account for a ticket every thirty
    // seconds forever is a browser that looks busy and is not connected.
    let minted;
    try {
      minted = await this.deps.mintTicket();
    } catch (e) {
      if (e?.fatal || e?.status === "UNAUTHENTICATED") {
        this.setState("signed_out");
        return;
      }
      this.scheduleReconnect();
      return;
    }
    if (!minted?.ticket || !minted?.relayUrl) {
      this.setState("signed_out");
      return;
    }

    let ws;
    try {
      ws = new this.deps.WebSocketCtor(minted.relayUrl);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;

    ws.onopen = () => {
      // IN-BAND AUTH, because a browser WebSocket cannot set headers — which is also why the
      // relay's WS route has no Cloudflare Access policy in front of it and why this frame is the
      // only gate. Identity comes from the ticket; everything else here is display metadata.
      this.send({
        t: "hello",
        v: 2,
        ticket: minted.ticket,
        label: this.identity.label,
        agentString: this.identity.agentString,
        extensionVersion: this.identity.extensionVersion,
      });
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {
      /* onclose follows and handles cleanup */
    };
    ws.onclose = () => {
      if (this.socket === ws) {
        this.stopHeartbeat();
        this.socket = null;
        if (!this.closed && this.connState !== "signed_out" && this.connState !== "unauthorized") {
          this.setState("disconnected");
        }
        this.scheduleReconnect();
      }
    };
  }

  reconnect() {
    this.stopHeartbeat();
    try {
      this.socket?.close();
    } catch (e) {}
    this.socket = null;
    this.backoff = 0;
    this.connect();
  }

  teardown() {
    this.closed = true;
    this.stopHeartbeat();
    try {
      this.socket?.close();
    } catch (e) {}
    this.socket = null;
    for (const tabId of this.executor.tabIndex.keys()) {
      try {
        chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
      } catch (e) {}
    }
    this.setState("disconnected");
  }

  onMessage(data) {
    let m;
    try {
      m = JSON.parse(data);
    } catch (e) {
      return;
    }
    switch (m.t) {
      case "welcome":
        this.backoff = 0;
        this.ownerUid = m.ownerUid ?? null;
        this.setState("connected");
        this.startHeartbeat(m.heartbeatMs || DEFAULT_HEARTBEAT_MS);
        break;
      case "error":
        // `code` is load-bearing, not decoration. An expired ticket means "mint another and retry
        // NOW" — backing off exponentially on it is a browser that silently stops working ten
        // minutes after it was last used, which is the commonest case there is (a laptop that
        // slept). `unauthorized` is the opposite: stop, and let a human see why.
        if (m.code === "ticket_expired") {
          this.backoff = 0;
          setTimeout(() => this.reconnect(), 0);
        } else if (m.code === "capacity") {
          this.scheduleReconnect();
        } else {
          this.setState("unauthorized");
        }
        break;
      case "ping":
        this.send({ t: "pong" });
        break;
      case "pong":
        break;
      case "cmd":
        this.handleCmd(m);
        break;
      case "session_open":
        this.setAllowlist(m.sessionId, m.allowedOrigins);
        this.sessionBlocklists.set(m.sessionId, m.blockedOrigins ?? []);
        this.persistSessions();
        this.executor.getSession(m.sessionId);
        break;
      case "session_config":
        // A captain edited the list mid-run. Applied to the NEXT action rather than to the tab
        // that is already open: closing somebody's tab out from under a running agent is a worse
        // failure than one more action on a page that has just become disallowed.
        if (this.sessionBlocklists.has(m.sessionId)) {
          // Each list is replaced only when the message carries it, as the relay sends only what
          // changed. An allow list sent as [] is a real change: back to "any site".
          if (m.blockedOrigins !== undefined) this.sessionBlocklists.set(m.sessionId, m.blockedOrigins ?? []);
          if (m.allowedOrigins !== undefined) this.setAllowlist(m.sessionId, m.allowedOrigins);
          this.persistSessions();
        }
        break;
      case "session_close":
        this.sessionBlocklists.delete(m.sessionId);
        this.sessionAllowlists.delete(m.sessionId);
        this.persistSessions();
        this.executor
          .closeSession(m.sessionId)
          .finally(() => this.send({ t: "session_closed", sessionId: m.sessionId }));
        break;
    }
  }

  async handleCmd(m) {
    const args = m.args || {};
    // ONCE, and before anything is judged: a command that arrives while this worker is still warming
    // up must wait for the persisted policy rather than be measured against a map that is not filled
    // in yet. `restoreSessions` never rejects, so this cannot wedge the command loop.
    this.restored ??= this.restoreSessions();
    await this.restored;

    // PAUSE ALL AGENTS, enforced here as well as on the server, and FIRST: a paused browser does
    // nothing, whatever the session or the URL. Kilogent checks the pause on every dispatch too;
    // this one holds when the server has not heard yet, or cannot be reached.
    if (this.deps.isPaused?.()) {
      this.send({
        t: "res",
        id: m.id,
        ok: false,
        error: {
          code: "paused",
          message: withCode(
            "paused",
            "The owner has paused all agents on this browser. Nothing was done. Try again after they resume it.",
          ),
        },
      });
      return;
    }

    if (!this.knowsSession(m.sessionId)) {
      this.send({
        t: "res",
        id: m.id,
        ok: false,
        error: { code: "blocked", message: this.unknownPolicyRefusal() },
      });
      return;
    }
    // Checked HERE as well as in Crew, because a URL can also arrive without any tool naming it —
    // a click on a link. This arm catches the one an argument names.
    //
    // THE REST IS NOW ACTUALLY COVERED, and this comment used to claim it already was: it said
    // "`Executor`'s own post-navigation assertion catches the rest" when no such assertion existed
    // — `grep block executor.js` returned only `blockInput`. Two things cover it now: `allowUrl`,
    // which core asks after every action with wherever the tab ended up, and `Fetch.requestPaused`,
    // which refuses the request before it leaves the browser at all. This arm stays because it is
    // the LEGIBLE refusal — it answers the agent in a sentence, before any tab moves.
    const refused = typeof args.url === "string" ? this.refusalFor(args.url, m.sessionId) : null;
    if (refused) {
      this.send({ t: "res", id: m.id, ok: false, error: refused });
      return;
    }
    try {
      // Sampled BEFORE, compared after: a command "succeeded" whose navigation was refused mid-flight
      // must not be reported as success. A click on a blocked link returns `Clicked e41` and leaves
      // the tab exactly where it was, which is indistinguishable from a dead link unless we say so.
      const refusedBefore = this.refusalCountFor(m.sessionId);
      const result = await this.executor.execute(m.name, args, m.deadlineMs, m.sessionId);
      if (this.refusalCountFor(m.sessionId) > refusedBefore) {
        // AN ERROR, not a result: whatever core returned, this command ran into a refusal — the
        // navigation it caused was failed before loading, or the page it left the tab on is not
        // allowed. Nothing from the refused site was loaded; the tab shows Chrome's "blocked" page.
        const last = this.refusals.get(m.sessionId)?.last;
        const at = await this.pageUrlFor(m.sessionId);
        this.send({
          t: "res",
          id: m.id,
          ok: false,
          error: {
            code: last?.code || "blocked",
            message:
              (last?.message ||
                withCode("blocked", "That went to an address this browser refused, so the page was not loaded.")) +
              (at ? `\nPage URL: ${at}` : ""),
          },
        });
        return;
      }
      this.send({ t: "res", id: m.id, ok: true, result: await this.withPageUrl(m.sessionId, result) });
    } catch (e) {
      this.send({
        t: "res",
        id: m.id,
        ok: false,
        error: { code: e.code || "error", message: String(e.message || e) },
      });
    }
  }

  send(obj) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(obj));
      } catch (e) {}
    }
  }

  pushStatus(attached, tabId, url, reason) {
    this.send({
      t: "status",
      attached,
      tabId: tabId ?? null,
      url: url ?? null,
      reason,
      sessions: this.executor.sessionsSummary(),
    });
    this.deps.onStateChange?.();
  }

  /**
   * The heartbeat serves FOUR masters at once — MV3's ~30s idle eviction, Cloudflare's 100s idle
   * WebSocket close, half-open TCP detection, and the relay's presence view. Raising it past ~25s
   * breaks the product in ways no log on the box will explain.
   */
  startHeartbeat(intervalMs) {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.send({ t: "ping" }), intervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.closed || this.connState === "signed_out" || this.connState === "unauthorized") return;
    const delay =
      Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, this.backoff)) + Math.random() * 500;
    this.backoff = Math.min(this.backoff + 1, 5);
    setTimeout(() => this.connect(), delay);
  }

  statusSnapshot() {
    let tabCount = 0;
    for (const s of this.executor.sessions.values()) tabCount += s.tabs.size;
    return {
      kind: "kilogent",
      id: this.identity.browserId,
      name: this.identity.label,
      connState: this.connState,
      ownerUid: this.ownerUid,
      socketOpen: !!this.socket && this.socket.readyState === WebSocket.OPEN,
      debuggerAttached: this.executor.anyAttached(),
      tabCount,
      sessionCount: this.sessionBlocklists.size,
    };
  }
}
