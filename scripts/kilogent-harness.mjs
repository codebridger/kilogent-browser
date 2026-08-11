// Automated Kilogent-mode harness — no Chrome, no Firebase, no VM.
//
// WHY THIS EXISTS AT ALL. The extension's Kilogent half talks to a server that lives in a DIFFERENT,
// private repository, so nothing links the two ends at compile time: `src/providers/kilogent/connection.js` here
// and `packages/crew/relay/src/protocol.ts` there are two hand-written descriptions of one wire
// format. That is exactly the shape of bug that passes every test on both sides — each checks its
// own belief — and it is how every 0.3.0 runner login broke. So this harness runs the REAL relay,
// from the published `@lumi.ai/relay` package, and makes the extension's real ConnectionManager
// satisfy it. If the two ever disagree, this is the thing that fails.
//
// Wiring:
//   • a REAL relay (`startRelay` on port 0) with a REAL ticket key
//   • a REAL KilogentConnection + the REAL Executor over a mocked `chrome.*`
//   • tickets minted with the relay's OWN `mintRelayTicket`, standing in for Crew
//   • commands driven through the relay's REAL control plane over HTTP
//
// Asserts: the v2 hello is accepted; a dispatch reaches the Executor and the result comes back;
// an expired ticket is retried rather than backed off; the two-level blocklist refuses at the
// extension even when the relay was happy to forward; a session close tears down that session's
// tabs and nobody else's.
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket as WsWebSocket } from "ws";
// ⚠️ THESE TWO REACH INTO THE RELAY'S BUILD OUTPUT BY PATH, and nothing checks that the paths
// still exist — not npm, not a type-checker. They are correct for `@lumi.ai/relay@0.1.2`, which
// this repo pins.
//
// The relay has ALREADY moved `ticket.js` to `dist/providers/ticket/ticket.js` upstream, as part of
// making its authentication pluggable. So the next published relay breaks the second line here.
// Two things follow, and they are the whole reason this note exists:
//   • that release must be a MINOR bump (0.2.0), never a patch — `^0.1.2` would silently take a
//     0.1.3 and this harness would fail on an import, in a repo whose CI is not watching the relay;
//   • when you take it, bump the dependency and fix the path IN THE SAME COMMIT.
import { startRelay } from "@lumi.ai/relay/dist/server.js";
import { mintRelayTicket } from "@lumi.ai/relay/dist/ticket.js";
import { Executor } from "../packages/extension/src/executor.js";
import { KilogentConnection } from "../packages/extension/src/providers/kilogent/connection.js";
import { effectiveBlocklist, isBlocked } from "../packages/extension/src/providers/kilogent/blocklist.js";

// connection code reads WebSocket.OPEN/CONNECTING off the global; point it at `ws` in Node.
globalThis.WebSocket = WsWebSocket;

const TICKET_KEY = "harness-ticket-signing-key";
const CONTROL_KEY = "harness-control-key";
const OWNER = "uid_harness_owner";
const BROWSER_ID = "brw_harness";

let failures = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.log(`  ✗ ${m}`);
  failures++;
};
const ok = (cond, m) => (cond ? pass(m) : fail(m));

// ── mock chrome.* (the same shape mock-profiles-harness.mjs uses) ──────────────────────────────
let nextTabId = 100;
let nextGroupId = 500;
const tabs = new Map();
function makeTab(url) {
  const id = ++nextTabId;
  for (const t of tabs.values()) t.active = false;
  const tab = { id, url: url || "about:blank", title: url || "about:blank", active: true };
  tabs.set(id, tab);
  return tab;
}
globalThis.chrome = {
  runtime: { lastError: undefined },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  tabs: {
    get: (id) => (tabs.has(id) ? Promise.resolve({ ...tabs.get(id) }) : Promise.reject(new Error("no tab"))),
    query: () => Promise.resolve([...tabs.values()].map((t) => ({ ...t }))),
    create: ({ url }) => Promise.resolve(makeTab(url)),
    remove: (id) => (tabs.delete(id), Promise.resolve()),
    update: (id, props) => {
      const t = tabs.get(id);
      if (t && props.active) {
        for (const x of tabs.values()) x.active = false;
        t.active = true;
      }
      return Promise.resolve(t ? { ...t } : undefined);
    },
    group: () => Promise.resolve(++nextGroupId),
  },
  tabGroups: { update: () => Promise.resolve() },
  debugger: {
    attach: (_t, _v, cb) => cb?.(),
    detach: (_t, cb) => cb?.(),
    sendCommand: (target, method, params, cb) => {
      // Enough CDP to make navigate/snapshot/screenshot resolve. The CDP layer itself is covered
      // by the existing harnesses; what is under test here is the Kilogent transport around it.
      if (method === "Page.navigate") {
        const t = tabs.get(target.tabId);
        if (t && params?.url) t.url = params.url;
        return cb?.({});
      }
      if (method === "Runtime.evaluate") {
        // Branching on the expression, exactly as mock-profiles-harness.mjs does. A single canned
        // value cannot serve both: `waitForLoad` polls for `{ready, href}` and gives up after 30s
        // if it never sees "complete", which surfaces as a dispatch TIMEOUT rather than an error —
        // and is what this harness did while it was still sending a tool name no executor has.
        const t = tabs.get(target.tabId);
        const value = params.expression.includes("document.readyState")
          ? { ready: "complete", href: t ? t.url : "about:blank" }
          : `SNAPSHOT[${t ? t.url : "?"}]`;
        return cb?.({ result: { value } });
      }
      if (method === "Page.captureScreenshot") return cb?.({ data: "ZmFrZQ==" });
      return cb?.({});
    },
    onDetach: { addListener: () => {} },
  },
};

// ── helpers ───────────────────────────────────────────────────────────────────────────────────
async function dispatch(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CONTROL_KEY}` },
    body: JSON.stringify({ ownerUid: OWNER, browserId: BROWSER_ID, ...body }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitFor(predicate, ms = 5000, label = "condition") {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  console.log("=== Kilogent mode: the extension against a REAL relay ===");

  const relay = await startRelay({
    port: 0,
    bindHost: "127.0.0.1",
    controlKey: CONTROL_KEY,
    ticketKey: TICKET_KEY,
    maxBrowsers: 10,
    sessionIdleMs: 60_000,
    drainGraceMs: 500,
    healthUrl: null,
    healthIntervalMs: 30_000,
    instanceId: "harness",
  });
  const port = relay.port;
  const relayUrl = `ws://127.0.0.1:${port}/ws`;

  // Stands in for Crew's `mintBrowserRelayTicket`, using the relay's OWN minting code — which is
  // the point: a ticket this harness makes is byte-identical in shape to one Crew makes, because
  // `check-browser-ticket-parity.mjs` in the Kilogent repo holds those two implementations together.
  let mintCount = 0;
  let mintTicketTtlMs = null;
  const mintTicket = async () => {
    mintCount++;
    return {
      ticket: mintRelayTicket(
        TICKET_KEY,
        { ownerUid: OWNER, browserId: BROWSER_ID },
        mintTicketTtlMs === null ? Date.now() : Date.now() - mintTicketTtlMs,
      ),
      relayUrl,
    };
  };

  let ownBlocklist = [];
  const conn = new KilogentConnection(
    {
      browserId: BROWSER_ID,
      label: "Harness MacBook",
      agentString: "Harness/1.0",
      extensionVersion: "0.2.0",
    },
    {
      WebSocketCtor: WsWebSocket,
      makeExecutor: (pushStatus, label) => new Executor(pushStatus, label),
      mintTicket,
      ownBlocklist: () => ownBlocklist,
      effectiveBlocklist,
      isBlocked,
      log: () => {},
    },
  );

  // ── 1. the v2 handshake ─────────────────────────────────────────────────────────────────────
  console.log("-- handshake --");
  await conn.connect();
  await waitFor(() => conn.connState === "connected", 5000, "welcome");
  ok(conn.connState === "connected", "the relay accepts the extension's v2 hello");
  ok(conn.ownerUid === OWNER, "and the welcome echoes the identity the TICKET proved, not a claim");
  ok(relay.hub.size === 1, "the relay is holding exactly one browser");

  // ── 2. a dispatch round-trip ────────────────────────────────────────────────────────────────
  console.log("-- dispatch --");
  const opened = await dispatch(port, {
    name: "browser_navigate",
    args: { url: "https://example.test/" },
    sessionId: "job1",
    timeoutMs: 5000,
  });
  ok(opened.status === 200, "a dispatch through the control plane returns 200");
  ok(opened.body?.outcome === "ok", "with outcome ok");
  ok(!!opened.body?.result?.content?.length, "and an MCP-shaped result the relay never reshaped");
  // NOT JUST "something came back". `hub.ts` settles a failed `res` as
  // `{outcome:"ok", result:{content:[…], isError:true}}`, so a content-length check passes on an
  // ERROR — which is exactly how this harness sat green while dispatching `browser_open`, a name
  // no executor has ever had. Assert the absence of isError, or this proves only that the wire
  // works.
  ok(
    !!opened.body?.result && opened.body.result.isError !== true,
    "and it SUCCEEDED — an error result also carries content, so isError is the real check",
  );

  // ── 3. the blocklist, enforced HERE ──────────────────────────────────────────────────────────
  //
  // The relay forwards happily — it holds no policy — so a refusal at this point can only have
  // come from the extension, which is the half that still works when a click navigates somewhere
  // no tool ever named.
  console.log("-- blocklist --");
  await dispatch(port, {
    name: "browser_navigate",
    args: { url: "https://ok.test/" },
    sessionId: "job2",
    blockedOrigins: ["https://bank.test"],
    timeoutMs: 5000,
  });
  const blockedByShip = await dispatch(port, {
    name: "browser_navigate",
    args: { url: "https://bank.test/login" },
    sessionId: "job2",
    timeoutMs: 5000,
  });
  // Asserted on the REFUSAL TEXT rather than on the outcome code, because the relay is not the
  // one refusing: it forwarded happily and reported `ok`, and the error travelled back inside the
  // extension's own `res` frame. Checking `outcome` here would have been checking the relay.
  ok(
    JSON.stringify(blockedByShip.body ?? {}).includes("blocked"),
    "a Ship-blocked origin is refused BY THE EXTENSION — the relay holds no policy",
  );

  ownBlocklist = ["https://payroll.test"];
  const blockedByOwner = await dispatch(port, {
    name: "browser_navigate",
    args: { url: "https://payroll.test/" },
    sessionId: "job2",
    timeoutMs: 5000,
  });
  ok(
    JSON.stringify(blockedByOwner.body).includes("blocked"),
    "and so does one only the OWNER blocked — the union, not the Ship's list alone",
  );

  const lookalike = await dispatch(port, {
    name: "browser_navigate",
    args: { url: "https://bank.test.evil.test/" },
    sessionId: "job2",
    timeoutMs: 5000,
  });
  ok(
    !JSON.stringify(lookalike.body ?? {}).includes("blocked"),
    "a LOOK-ALIKE host is not the blocked origin — matching is anchored, not a prefix",
  );

  // ── 4. an expired ticket is retried, not backed off ─────────────────────────────────────────
  //
  // The commonest case there is: a laptop that slept. An extension that treats `ticket_expired`
  // like an auth failure stops working ten minutes after it was last used, silently.
  console.log("-- expiry --");
  const beforeMints = mintCount;
  mintTicketTtlMs = 20 * 60 * 1000; // mint one that was already stale when it was made
  conn.reconnect();
  await sleep(600);
  mintTicketTtlMs = null; // the retry gets a good one
  await waitFor(() => conn.connState === "connected", 8000, "reconnect after ticket_expired");
  ok(conn.connState === "connected", "an expired ticket is re-minted and the socket comes back");
  ok(mintCount > beforeMints + 1, "which took more than one mint — it retried rather than gave up");

  // ── 5. session teardown ──────────────────────────────────────────────────────────────────────
  console.log("-- sessions --");
  await dispatch(port, { name: "browser_navigate", args: { url: "https://a.test/" }, sessionId: "jobA", timeoutMs: 5000 });
  await dispatch(port, { name: "browser_navigate", args: { url: "https://b.test/" }, sessionId: "jobB", timeoutMs: 5000 });
  const before = conn.executor.sessions.size;
  await fetch(`http://127.0.0.1:${port}/v1/session/close`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CONTROL_KEY}` },
    body: JSON.stringify({ ownerUid: OWNER, browserId: BROWSER_ID, sessionId: "jobA" }),
  });
  await sleep(400);
  ok(before >= 2, "two sessions were open");
  ok(!conn.executor.sessions.has("jobA"), "closing one tears its session down");
  ok(conn.executor.sessions.has("jobB"), "and leaves the other alone");

  // ── 6. a browser nobody is holding ──────────────────────────────────────────────────────────
  const missing = await dispatch(port, {
    name: "browser_navigate",
    args: {},
    timeoutMs: 2000,
    browserId: "brw_nobody",
  });
  ok(
    missing.body?.outcome === "browser_not_here",
    "dispatching to a browser the relay is not holding says so, rather than hanging",
  );

  conn.teardown();
  await relay.close(200);

  console.log(failures === 0 ? "\n✅ kilogent harness passed" : `\n❌ ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
