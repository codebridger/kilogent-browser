// Automated Kilogent-mode harness — no Chrome, no Firebase, no VM.
//
// WHY THIS EXISTS AT ALL. The extension's Kilogent half and the relay are two hand-written
// descriptions of one wire format — `src/providers/kilogent/connection.js` here and
// `packages/relay/src/protocol.ts` beside it. That is exactly the shape of bug that passes every
// test on both sides, because each checks its own belief, and it is how every 0.3.0 runner login
// broke. So this harness runs the REAL relay and makes the extension's real ConnectionManager
// satisfy it. If the two ever disagree, this is the thing that fails.
//
// IT USED TO REACH INTO A PUBLISHED PACKAGE BY PATH, with a note right here warning that the next
// relay release would move `ticket.js` and break the import — in a repo whose CI was not watching
// the relay. That release happened. The fix was not a tighter version pin: the relay lives in THIS
// repository now, so these are relative imports into a workspace the test script has just built,
// and a moved file fails here rather than three weeks later.
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
// The relay's BUILD OUTPUT, not its source: `packages/relay` is TypeScript and this harness is
// plain Node. `npm run test:kilogent` runs `build:relay` first, so `dist/` is always current.
import { startRelay } from "../packages/relay/dist/server.js";
import { mintRelayTicket } from "../packages/relay/dist/providers/ticket/ticket.js";
import { resolveAuthProvider } from "../packages/relay/dist/providers/index.js";
import { Executor } from "../packages/extension/src/executor.js";
import { KilogentConnection } from "../packages/extension/src/providers/kilogent/connection.js";
import { effectiveBlocklist, isBlocked } from "../packages/extension/src/providers/kilogent/blocklist.js";

// connection code reads WebSocket.OPEN/CONNECTING off the global; point it at `ws` in Node.
globalThis.WebSocket = WsWebSocket;

// ≥32 characters, and DIFFERENT from each other, because the real ticket provider refuses both —
// a short key, and a control key that doubles as the signing key. Fixed strings rather than random
// ones so a failure is reproducible; they never leave this process.
const TICKET_KEY = "harness-ticket-signing-key-0000000000000000000000000000000000000";
const CONTROL_KEY = "harness-control-key-1111111111111111111111111111111111111111111";
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
/** Where the next click lands the tab. Null = a click does not navigate. */
let clickLandsOn = null;
/** When set, a click's navigation is REFUSED by interception and the tab does NOT move. */
let clickBlockedBy = null;
let pausedSeq = 0;
/** The live connection, so the module-level chrome fake can reach it. `conn` itself is a local
 *  of `main()`, which the fake's closure cannot see — that is why this exists. */
let connRef = null;
/** Tabs the transport armed interception on, and how it answered each paused request. */
const armedTabs = new Set();
const fetchAnswers = [];
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
      // A CLICK THAT NAVIGATES — the bug itself, in the fake. `RESOLVE_BOX_FN` is what `click()`
      // evaluates to locate the element, so answering it also MOVES the tab, exactly as following a
      // real link does. Without this the fake tab never moves, and every click assertion below
      // would pass against a guard that does nothing.
      if (method === "Runtime.evaluate" && params.expression.includes("__rbm") && clickBlockedBy) {
        // THE REAL SEQUENCE. The click fires, the navigation it starts is paused and refused, and
        // the tab stays exactly where it was. Nothing moves — so every later "where is the tab"
        // check sees an allowed page, which is precisely why the block must be RECORDED and cannot
        // be inferred afterwards.
        return void connRef
          .onDebuggerEvent({ tabId: target.tabId }, "Fetch.requestPaused", {
            requestId: "req-click-" + ++pausedSeq,
            request: { url: clickBlockedBy },
          })
          .then(() => cb?.({ result: { value: { found: true, x: 1, y: 1 } } }));
      }
      if (method === "Runtime.evaluate" && params.expression.includes("__rbm") && clickLandsOn) {
        const t = tabs.get(target.tabId);
        if (t) t.url = clickLandsOn;
        return cb?.({ result: { value: { found: true, x: 1, y: 1 } } });
      }
      if (method === "Fetch.enable") {
        armedTabs.add(target.tabId);
        return cb?.({});
      }
      if (method === "Fetch.continueRequest" || method === "Fetch.failRequest") {
        fetchAnswers.push({ method, requestId: params?.requestId });
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
    // WHO A BROWSER IS is a pluggable provider now, not a key on the config — so this builds the
    // one Kilogent actually deploys (`ticket`, the default) through the relay's OWN resolver,
    // rather than hand-rolling something shaped like it. Standing up the real provider is the
    // point: a change to how a ticket is verified has to reach this harness, and a fake would be
    // exactly the stand-in that accepts anything and proves nothing.
    auth: resolveAuthProvider({
      RELAY_TICKET_KEY: TICKET_KEY,
      RELAY_CONTROL_KEY: CONTROL_KEY,
    }),
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
        // `ownerId`, not `ownerUid`. TWO NAMES ARE LIVE for one value and they are not
        // interchangeable: `ownerUid` is the WIRE name — what the welcome frame carries and what
        // the control plane still accepts in a body, both for extensions already installed — while
        // `ownerId` is what the code calls it. This is a code call, so it is `ownerId`, and passing
        // the wire name here mints nothing and the handshake simply times out.
        { ownerId: OWNER, browserId: BROWSER_ID },
        mintTicketTtlMs === null ? Date.now() : Date.now() - mintTicketTtlMs,
      ),
      relayUrl,
    };
  };

  let ownBlocklist = [];
  const conn = (connRef = new KilogentConnection(
    {
      browserId: BROWSER_ID,
      label: "Harness MacBook",
      agentString: "Harness/1.0",
      extensionVersion: "0.2.0",
    },
    {
      WebSocketCtor: WsWebSocket,
      // The SAME policy `providers/kilogent/index.js` wires in production. Without it this harness
      // would drive an executor with no guard and every assertion below about clicks would be
      // testing an object the product does not ship.
      makeExecutor: (pushStatus, label) =>
        new Executor(pushStatus, label, {
          allowUrl: (url, ctx) => conn.allowUrl(url, ctx),
          onAttached: (chromeTabId) => conn.armTab(chromeTabId),
        }),
      mintTicket,
      ownBlocklist: () => ownBlocklist,
      effectiveBlocklist,
      isBlocked,
      log: () => {},
    },
  ));

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

  // ── the gap: a click, which names no URL ──────────────────────────────────────────────────────
  //
  // Every assertion above dispatches `browser_navigate` with a literal `url`, which the argument
  // check in connection.js has always caught. The bug was everything else: an agent opens an
  // allowed page, clicks a link, and lands wherever the link goes. A comment claimed "`Executor`'s
  // own post-navigation assertion catches the rest", and there was no such assertion.
  clickLandsOn = "https://bank.test/statement";
  const blockedByClick = await dispatch(port, {
    name: "browser_click",
    args: { ref: "e1", element: "a link" },
    sessionId: "job2",
    timeoutMs: 5000,
  });
  ok(
    JSON.stringify(blockedByClick.body ?? {}).includes("blocked"),
    "a CLICK that lands on a blocked origin is refused — the gap this closes",
  );
  ok(
    !JSON.stringify(blockedByClick.body ?? {}).includes("SNAPSHOT[https://bank.test"),
    "and the refusal carries no snapshot of the page it landed on",
  );

  clickLandsOn = "https://ok.test/elsewhere";
  const allowedClick = await dispatch(port, {
    name: "browser_click",
    args: { ref: "e1", element: "a link" },
    sessionId: "job2",
    timeoutMs: 5000,
  });
  ok(
    !JSON.stringify(allowedClick.body ?? {}).includes("blocked"),
    "a click that stays on an allowed origin is not disturbed",
  );
  clickLandsOn = null;

  // ── prevention, not merely refusal ────────────────────────────────────────────────────────────
  ok(armedTabs.size > 0, "interception was armed on the session's tabs");

  // The tab must be one of JOB2's — that is the session whose blocklist has bank.test on it.
  // `[...armedTabs][0]` picked whichever tab was armed first, which belongs to another session and
  // has an empty list, so the "blocked" assertion passed or failed on tab ordering rather than on
  // the guard.
  const armed = [...conn.executor.tabIndex.entries()].find(([, v]) => v.sessionId === "job2")?.[0];
  ok(typeof armed === "number", "job2 has an armed tab to intercept on");
  fetchAnswers.length = 0;
  await conn.onDebuggerEvent({ tabId: armed }, "Fetch.requestPaused", {
    requestId: "req-blocked",
    request: { url: "https://bank.test/anything" },
  });
  ok(
    fetchAnswers.some((a) => a.method === "Fetch.failRequest" && a.requestId === "req-blocked"),
    "a paused request to a blocked origin is FAILED before it leaves the browser",
  );

  fetchAnswers.length = 0;
  await conn.onDebuggerEvent({ tabId: armed }, "Fetch.requestPaused", {
    requestId: "req-ok",
    request: { url: "https://ok.test/page" },
  });
  ok(
    fetchAnswers.some((a) => a.method === "Fetch.continueRequest" && a.requestId === "req-ok"),
    "and an allowed one continues",
  );

  // THE EVICTION CASE. MV3 drops this worker whenever it likes and the tab index goes with it. A
  // request paused on a tab the transport no longer recognises must be REFUSED: allowing it is the
  // hole, and ignoring it hangs the tab until Chrome gives up on the navigation.
  fetchAnswers.length = 0;
  await conn.onDebuggerEvent({ tabId: 999999 }, "Fetch.requestPaused", {
    requestId: "req-amnesia",
    request: { url: "https://ok.test/page" },
  });
  ok(
    fetchAnswers.some((a) => a.method === "Fetch.failRequest" && a.requestId === "req-amnesia"),
    "an unrecognised tab FAILS the request — unknown state never means allow, and never hangs",
  );

  // ── the refusal must be LEGIBLE, which is what the live test caught ──────────────────────────
  //
  // `Fetch` stops the navigation, so the tab never moves — and `allowUrl`, asked afterwards where
  // the tab is, sees the page it was already on and permits the command. Prevention worked and the
  // agent was told nothing: it clicked, got "Clicked e41", read the page, found itself still on the
  // search results, and reported it could not tell a blocklist from a broken link.
  // Pre-bumping the counter here would prove nothing: the check only refuses when a block happens
  // DURING the command, which is the whole point. So the click itself must be the thing that gets
  // refused, exactly as it is in production.
  clickLandsOn = null;
  clickBlockedBy = "https://bank.test/statement";
  const blockedBefore = conn.blockedCountFor("job2");

  const afterBlockedNav = await dispatch(port, {
    name: "browser_click",
    args: { ref: "e1", element: "a link" },
    sessionId: "job2",
    timeoutMs: 5000,
  });
  ok(
    JSON.stringify(afterBlockedNav.body ?? {}).includes("blocked"),
    "and the next command REPORTS it — a silent no-op is indistinguishable from a dead link",
  );

  // KEYED BY SESSION, asserted directly. The dispatch below cannot prove this on its own: job1's
  // command starts AFTER job2's block, so even a global counter would sample the same value before
  // and after and refuse nothing. Reading both ledgers is what actually distinguishes the two.
  ok(
    conn.blockedCountFor("job2") > 0 && conn.blockedCountFor("job1") === 0,
    "the ledger is per-session — job1 carries none of job2's refusals",
  );

  // And the command itself is undisturbed: two sessions run concurrently on one connection.
  const otherSession = await dispatch(port, {
    name: "browser_read",
    args: {},
    sessionId: "job1",
    timeoutMs: 5000,
  });
  ok(
    !JSON.stringify(otherSession.body ?? {}).includes("blocked"),
    "and another session's command is untouched by it",
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
