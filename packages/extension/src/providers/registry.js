// The transport registry — how one service worker serves several ways of reaching an agent.
//
// WHY THIS EXISTS. `sw.js` used to hold ONE transport: it constructed a `ConnectionManager`,
// wired Chrome's events straight into it, and answered the popup from it. That is fine while
// there is one, and it is exactly what a fork has to tear open to add a second — which is how
// this project's own branded build ended up with 320 extra lines inside `sw.js`, conflicting on
// every merge from here.
//
// So the worker now owns Chrome's plumbing and nothing else, and this owns the fan-out. A fork
// adds a directory under `providers/` and one line in `providers/index.js`; `sw.js` is untouched
// and stays mergeable forever.
//
// AND IT IS TESTABLE, which the old arrangement was not. `sw.js` imports `chrome.*` at the top
// level, so nothing outside a browser could ever load it and the fan-out was the least-tested
// code in the extension despite being the piece every command passes through. Nothing in this
// file touches a Chrome API — the worker hands it what it needs — so `scripts/registry-test.mjs`
// drives it with fakes.
//
// ONE PROVIDER MUST NOT BE ABLE TO BREAK ANOTHER. Every call below is isolated: a provider that
// throws is logged and skipped, and the remaining providers still run. Without that, a fork's
// half-finished transport takes the self-hosted bridge down with it, on a laptop, with no console
// open — and the symptom is a browser that connects to nothing for no visible reason.

/**
 * @typedef {object} Transport
 * @property {string} name                        Its key in a status snapshot, and in logs.
 * @property {() => any} [reconcile]              Bring live connections in line with storage.
 * @property {() => void} [reconnectAll]
 * @property {(source:any, reason:any) => void} [onDetach]      Ignore tabs that are not yours.
 * @property {(tabId:number) => void} [onTabRemoved]            Ignore tabs that are not yours.
 * @property {() => object} [status]              Shallow-merged into the popup's snapshot.
 * @property {(msg:any) => any} [onMessage]       Return undefined to pass; anything else claims it.
 * @property {() => void} [teardown]
 */

export class TransportRegistry {
  /**
   * @param {Transport[]} transports
   * @param {{log?: (...a:any[]) => void}} [deps]
   */
  constructor(transports, deps = {}) {
    this.transports = (transports || []).filter(Boolean);
    this.log = deps.log || (() => {});
  }

  /** Run `fn` on every transport, isolating failures. Returns the results that did not throw. */
  #each(method, fn) {
    const out = [];
    for (const t of this.transports) {
      if (typeof t[method] !== "function") continue;
      try {
        out.push({ transport: t, value: fn(t) });
      } catch (err) {
        // Logged, never rethrown — see the file header.
        this.log(`[registry] ${t.name}.${method} threw:`, err);
      }
    }
    return out;
  }

  /** Cold start, and every keepalive alarm. */
  async reconcile() {
    // Collected first, then awaited, so a slow transport does not delay the others' start.
    const pending = this.#each("reconcile", (t) => t.reconcile());
    for (const { transport, value } of pending) {
      try {
        await value;
      } catch (err) {
        this.log(`[registry] ${transport.name}.reconcile rejected:`, err);
      }
    }
  }

  reconnectAll() {
    this.#each("reconnectAll", (t) => t.reconnectAll());
  }

  /**
   * Debugger detach and tab close are BROADCAST, not routed to one owner.
   *
   * Each transport already ignores a tab it does not own — that check lives with the thing that
   * knows its own tabs — so asking the registry to find the owner first would duplicate it, and
   * duplicate it in the one place that has the least information.
   */
  onDetach(source, reason) {
    this.#each("onDetach", (t) => t.onDetach(source, reason));
  }

  onTabRemoved(tabId) {
    this.#each("onTabRemoved", (t) => t.onTabRemoved(tabId));
  }

  /**
   * The popup's view, shallow-merged.
   *
   * Shallow and not namespaced, because the popup already reads `profiles` at the top level and a
   * namespace would break every existing reader for no gain. Transports are responsible for not
   * colliding; a collision is a bug in whichever one was added second.
   */
  status() {
    const merged = {};
    for (const { transport, value } of this.#each("status", (t) => t.status())) {
      if (!value || typeof value !== "object") continue;
      for (const [k, v] of Object.entries(value)) {
        if (k in merged) this.log(`[registry] ${transport.name} overwrote status key "${k}"`);
        merged[k] = v;
      }
    }
    return merged;
  }

  /**
   * Offer a popup message to each transport until one claims it.
   *
   * FIRST CLAIMER WINS and the rest never see it, because the caller can answer a Chrome message
   * exactly once — a second `sendResponse` is dropped silently, so two transports both handling a
   * message is a bug that never shows up as an error.
   *
   * Returns `{ handled: false }` when nobody claimed it, which the worker turns into a `false`
   * return so Chrome knows not to wait for a reply that is never coming.
   */
  async onMessage(msg) {
    for (const t of this.transports) {
      if (typeof t.onMessage !== "function") continue;
      let result;
      try {
        result = t.onMessage(msg);
      } catch (err) {
        this.log(`[registry] ${t.name}.onMessage threw:`, err);
        continue;
      }
      if (result === undefined) continue; // not mine
      try {
        return { handled: true, by: t.name, response: await result };
      } catch (err) {
        // It CLAIMED the message and then failed. Answering with the error is better than
        // silence: the popup is waiting, and a promise nobody settles is a spinner forever.
        this.log(`[registry] ${t.name}.onMessage rejected:`, err);
        return { handled: true, by: t.name, response: { ok: false, error: String(err?.message ?? err) } };
      }
    }
    return { handled: false };
  }

  teardown() {
    this.#each("teardown", (t) => t.teardown());
  }
}
