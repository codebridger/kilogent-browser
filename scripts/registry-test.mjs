#!/usr/bin/env node
// The transport registry, against fake transports. No Chrome, no sockets, no build.
//
// This covers code that had NO test at all before the split. It used to live in `sw.js`, which
// imports `chrome.*` at the top level and therefore cannot be loaded outside a browser — so the
// fan-out that every command passes through was the least-tested code in the extension, and the
// only way to exercise it was to load the extension and click something.
//
// The property worth the most here is ISOLATION: one transport throwing must not stop another.
// A fork's half-finished transport should not be able to take the self-hosted bridge down with it,
// on somebody's laptop, with no console open.

import assert from "node:assert/strict";
import { TransportRegistry } from "../packages/extension/src/providers/registry.js";

let pass = 0;
const failures = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failures.push(name);
      console.error(`  ✗ ${name}`);
      console.error(`      ${String(err && err.message).split("\n").slice(0, 3).join("\n      ")}`);
    });
}

/** A transport that records what it was asked to do. */
function fake(name, overrides = {}) {
  const calls = [];
  return {
    name,
    calls,
    reconcile() { calls.push("reconcile"); },
    reconnectAll() { calls.push("reconnectAll"); },
    onDetach(source, reason) { calls.push(["onDetach", source, reason]); },
    onTabRemoved(tabId) { calls.push(["onTabRemoved", tabId]); },
    status() { calls.push("status"); return {}; },
    onMessage() { calls.push("onMessage"); return undefined; },
    teardown() { calls.push("teardown"); },
    ...overrides,
  };
}

const quiet = { log: () => {} };

console.log("Transport registry:");

await check("reconcile reaches every transport", async () => {
  const a = fake("a"), b = fake("b");
  await new TransportRegistry([a, b], quiet).reconcile();
  assert.deepEqual(a.calls, ["reconcile"]);
  assert.deepEqual(b.calls, ["reconcile"]);
});

await check("a transport that THROWS does not stop the others", async () => {
  // The whole reason the registry isolates each call.
  const boom = fake("boom", { reconcile() { throw new Error("bang"); } });
  const ok = fake("ok");
  await new TransportRegistry([boom, ok], quiet).reconcile();
  assert.deepEqual(ok.calls, ["reconcile"], "the second transport never ran");
});

await check("a transport whose async reconcile REJECTS does not stop the others", async () => {
  // Different path from a synchronous throw: the error arrives after the loop has moved on, so
  // an implementation that only try/catches the call site still fails this.
  const order = [];
  const boom = fake("boom", { reconcile: async () => { order.push("boom"); throw new Error("later"); } });
  const ok = fake("ok", { reconcile: async () => { order.push("ok"); } });
  await new TransportRegistry([boom, ok], quiet).reconcile();
  assert.deepEqual(order, ["boom", "ok"]);
});

await check("detach and tab-close are BROADCAST, not given to one owner", async () => {
  // Each transport ignores tabs it does not own; the registry does not try to guess the owner.
  const a = fake("a"), b = fake("b");
  const r = new TransportRegistry([a, b], quiet);
  r.onDetach({ tabId: 7 }, "canceled_by_user");
  r.onTabRemoved(7);
  assert.deepEqual(a.calls, [["onDetach", { tabId: 7 }, "canceled_by_user"], ["onTabRemoved", 7]]);
  assert.deepEqual(b.calls, a.calls, "the second transport was skipped");
});

await check("status is shallow-merged, so the popup keeps reading `profiles` at the top", async () => {
  const bridge = fake("bridge", { status: () => ({ profiles: [{ id: "p1" }] }) });
  const other = fake("other", { status: () => ({ signedIn: true, ships: ["s1"] }) });
  const merged = new TransportRegistry([bridge, other], quiet).status();
  assert.deepEqual(merged, { profiles: [{ id: "p1" }], signedIn: true, ships: ["s1"] });
});

await check("a transport with no status at all is skipped, not a crash", async () => {
  const bare = { name: "bare" };
  const bridge = fake("bridge", { status: () => ({ profiles: [] }) });
  assert.deepEqual(new TransportRegistry([bare, bridge], quiet).status(), { profiles: [] });
});

await check("the FIRST claimer wins, and the rest never see the message", async () => {
  // Chrome allows exactly one sendResponse. Two transports answering is a bug that never surfaces
  // as an error — the second reply is dropped silently — so it has to be impossible here.
  const first = fake("first", { onMessage: (m) => (m.type === "x" ? { ok: true, from: "first" } : undefined) });
  const second = fake("second", { onMessage: () => ({ ok: true, from: "second" }) });
  const out = await new TransportRegistry([first, second], quiet).onMessage({ type: "x" });
  assert.equal(out.handled, true);
  assert.equal(out.by, "first");
  assert.deepEqual(out.response, { ok: true, from: "first" });
  assert.deepEqual(second.calls, [], "the second transport was offered a claimed message");
});

await check("`undefined` means 'not mine' and passes the message along", async () => {
  const passes = fake("passes", { onMessage: () => undefined });
  const takes = fake("takes", { onMessage: () => ({ ok: true, from: "takes" }) });
  const out = await new TransportRegistry([passes, takes], quiet).onMessage({ type: "y" });
  assert.equal(out.by, "takes");
});

await check("a message nobody claims reports handled:false, so Chrome is not left waiting", async () => {
  const out = await new TransportRegistry([fake("a"), fake("b")], quiet).onMessage({ type: "nope" });
  assert.deepEqual(out, { handled: false });
});

await check("a FALSY answer still counts as claimed — only undefined passes", async () => {
  // `null` and `false` are real answers. Treating them as "not mine" would hand the message to the
  // next transport and answer twice.
  for (const answer of [null, false, 0, ""]) {
    const taker = fake("taker", { onMessage: () => answer });
    const next = fake("next", { onMessage: () => ({ from: "next" }) });
    const out = await new TransportRegistry([taker, next], quiet).onMessage({ type: "z" });
    assert.equal(out.by, "taker", `${JSON.stringify(answer)} was treated as unclaimed`);
    assert.deepEqual(next.calls, []);
  }
});

await check("a transport that claims and then REJECTS still answers", async () => {
  // It took the message, so nobody else will. Silence here is a popup spinner that never stops.
  const flaky = fake("flaky", { onMessage: () => Promise.reject(new Error("nope")) });
  const out = await new TransportRegistry([flaky], quiet).onMessage({ type: "x" });
  assert.equal(out.handled, true);
  assert.equal(out.response.ok, false);
  assert.match(out.response.error, /nope/);
});

await check("a transport that THROWS synchronously in onMessage passes rather than claiming", async () => {
  // It never got as far as answering, so the message is still up for grabs.
  const boom = fake("boom", { onMessage: () => { throw new Error("bang"); } });
  const ok = fake("ok", { onMessage: () => ({ from: "ok" }) });
  const out = await new TransportRegistry([boom, ok], quiet).onMessage({ type: "x" });
  assert.equal(out.by, "ok");
});

await check("reconnectAll and teardown reach everyone, and survive a thrower", async () => {
  const boom = fake("boom", { teardown() { throw new Error("bang"); } });
  const ok = fake("ok");
  const r = new TransportRegistry([boom, ok], quiet);
  r.reconnectAll();
  r.teardown();
  assert.ok(ok.calls.includes("reconnectAll"));
  assert.ok(ok.calls.includes("teardown"));
});

await check("nulls in the transport list are dropped rather than crashing at the first call", async () => {
  // A fork's `providers/index.js` with a commented-out entry should not be a broken extension.
  const ok = fake("ok");
  const r = new TransportRegistry([null, ok, undefined], quiet);
  await r.reconcile();
  assert.deepEqual(ok.calls, ["reconcile"]);
});

// ── the REAL shipped transport, not a fake ───────────────────────────────────────────────────
//
// Everything above proves the registry's contract against stand-ins, which proves nothing about
// the one transport this repository actually ships. A stand-in that satisfies a contract the real
// implementation does not is the failure this section exists to catch.

console.log("\nThe bridge transport (the real one):");

const { createBridgeTransport } = await import("../packages/extension/src/providers/bridge/index.js");

/** Chrome's storage, reduced to the two calls the transport makes. */
function fakeStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    get: async (keys) => Object.fromEntries(keys.map((k) => [k, store[k]]).filter(([, v]) => v !== undefined)),
    set: async (obj) => Object.assign(store, obj),
  };
}
const makeBridge = (storage) =>
  createBridgeTransport({ storage, WebSocketCtor: class {}, log: () => {} });

await check("it satisfies the shape the registry calls", async () => {
  const t = makeBridge(fakeStorage());
  assert.equal(t.name, "bridge");
  for (const m of ["reconcile", "reconnectAll", "onDetach", "onTabRemoved", "status", "onMessage", "teardown"]) {
    assert.equal(typeof t[m], "function", `bridge is missing ${m}`);
  }
});

await check("it passes on a message that is not one of its three", async () => {
  // If it claimed everything, a fork's transport would never receive a message — and the symptom
  // is a popup button that does nothing, with no error anywhere.
  const t = makeBridge(fakeStorage());
  assert.equal(t.onMessage({ type: "signIn" }), undefined);
  assert.equal(t.onMessage(null), undefined);
  assert.equal(t.onMessage({}), undefined);
});

await check("it claims exactly getStatus, saveProfiles and reconnect", async () => {
  const t = makeBridge(fakeStorage());
  assert.notEqual(t.onMessage({ type: "getStatus" }), undefined);
  assert.notEqual(t.onMessage({ type: "reconnect" }), undefined);
  assert.notEqual(t.onMessage({ type: "saveProfiles", profiles: [] }), undefined);
});

await check("it reports `profiles` at the top level, the shape the popup reads", async () => {
  assert.deepEqual(makeBridge(fakeStorage()).status(), { profiles: [] });
});

await check("saveProfiles writes through to storage", async () => {
  const storage = fakeStorage();
  const t = makeBridge(storage);
  const profiles = [{ id: "p1", name: "one", agentUrl: "", accessToken: "", enabled: false }];
  await t.onMessage({ type: "saveProfiles", profiles });
  assert.deepEqual(storage.store.profiles, profiles);
});

await check("it migrates the legacy single-profile shape exactly once", async () => {
  // Somebody who set this up before profiles existed has {agentUrl, accessToken} and no list.
  // Losing it means their bridge silently disconnects and the popup looks empty.
  const storage = fakeStorage({ agentUrl: "wss://old.example", accessToken: "tok" });
  await makeBridge(storage).reconcile();
  assert.equal(storage.store.profiles.length, 1, "the legacy profile was dropped");
  assert.equal(storage.store.profiles[0].agentUrl, "wss://old.example");
  assert.equal(storage.store.profiles[0].enabled, true);
});

await check("and a fresh install migrates to an empty list rather than throwing", async () => {
  const storage = fakeStorage();
  await makeBridge(storage).reconcile();
  assert.deepEqual(storage.store.profiles, []);
});

await check("the registry drives the real transport end to end", async () => {
  // The actual wiring `sw.js` performs, minus Chrome.
  const storage = fakeStorage();
  const registry = new TransportRegistry([makeBridge(storage)], quiet);
  await registry.reconcile();
  assert.deepEqual(registry.status(), { profiles: [] });
  const out = await registry.onMessage({ type: "getStatus" });
  assert.equal(out.handled, true);
  assert.equal(out.by, "bridge");
  assert.deepEqual(out.response, { profiles: [] });
  assert.deepEqual(await registry.onMessage({ type: "notMine" }), { handled: false });
});

if (failures.length) {
  console.error(`\n✗ transport registry: ${failures.length} failed, ${pass} passed.`);
  for (const f of failures) console.error(`    ${f}`);
  process.exit(1);
}
console.log(`\n✅ transport registry: ${pass} checks passed.`);
