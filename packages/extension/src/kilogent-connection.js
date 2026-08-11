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
  blocklistFor(sessionId) {
    const ship = this.sessionBlocklists.get(sessionId) ?? [];
    return this.deps.effectiveBlocklist(ship, this.deps.ownBlocklist());
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
        this.sessionBlocklists.set(m.sessionId, m.blockedOrigins ?? []);
        this.executor.getSession(m.sessionId);
        break;
      case "session_config":
        // A captain edited the list mid-run. Applied to the NEXT action rather than to the tab
        // that is already open: closing somebody's tab out from under a running agent is a worse
        // failure than one more action on a page that has just become disallowed.
        if (this.sessionBlocklists.has(m.sessionId)) {
          this.sessionBlocklists.set(m.sessionId, m.blockedOrigins ?? []);
        }
        break;
      case "session_close":
        this.sessionBlocklists.delete(m.sessionId);
        this.executor
          .closeSession(m.sessionId)
          .finally(() => this.send({ t: "session_closed", sessionId: m.sessionId }));
        break;
    }
  }

  async handleCmd(m) {
    const args = m.args || {};
    // Checked HERE as well as in Crew, because a URL can also arrive without any tool naming it —
    // a click on a link. This arm catches the one an argument names; `Executor`'s own
    // post-navigation assertion catches the rest.
    if (typeof args.url === "string" && this.deps.isBlocked(args.url, this.blocklistFor(m.sessionId))) {
      this.send({
        t: "res",
        id: m.id,
        ok: false,
        error: {
          code: "blocked",
          message:
            "That address is blocked on this browser. Ask its owner, or a captain — you cannot change this yourself.",
        },
      });
      return;
    }
    try {
      const result = await this.executor.execute(m.name, args, m.deadlineMs, m.sessionId);
      this.send({ t: "res", id: m.id, ok: true, result });
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
