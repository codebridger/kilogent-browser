#!/usr/bin/env node
// The popup's panels, against a real DOM. No Chrome, no extension load.
//
// The popup was the only surface with NO test of any kind, and it is the one a person actually
// touches: if it draws nothing, the extension is broken no matter how healthy the worker is. It
// stayed untested because it needed a DOM, and needing a DOM is a dependency away rather than a
// law of nature — so here is `happy-dom` and the tests that were always possible.
//
// It does NOT cover how any of this LOOKS. Layout, colour and spacing come from the stylesheet in
// `popup.html`, and nothing here renders a pixel. What it does cover is everything that can be
// wrong without being visible: which elements exist, what they say, which messages a click sends,
// and whether one panel failing takes the others with it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  ✗ ${name}`);
    console.error(`      ${String(err && err.message).split("\n").slice(0, 3).join("\n      ")}`);
  }
}

/** A window with the real popup.html in it, so the shell under test is the shipped one. */
function popupWindow() {
  const html = readFileSync(path.join(root, "packages/extension/popup.html"), "utf8");
  const window = new Window({ url: "chrome-extension://test/popup.html" });
  window.document.write(html);
  return window;
}

/**
 * NO GLOBAL SWAP IS NEEDED, and that is a property of the panels rather than of this file.
 *
 * The first version of this test installed `window.document` as a global around each call. It
 * failed the moment a panel drew from an ASYNC storage callback, which lands after the global has
 * been put back — so the panels now take their document from the element they are drawing into
 * (`el.ownerDocument`). A panel with no global dependency is one that works in any document,
 * including this one.
 */
const withDom = (_window, fn) => fn();

function fakeStorage(initial = {}) {
  const store = { ...initial };
  const pick = (keys) => {
    if (keys == null) return { ...store };
    const names = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of names) if (store[k] !== undefined) out[k] = store[k];
    return out;
  };
  return { store, get: async (k) => pick(k), set: async (o) => { Object.assign(store, o); } };
}

/** Records what the panel asked the worker to do. */
function recorder(answers = {}) {
  const sent = [];
  return {
    sent,
    send: async (msg) => {
      sent.push(msg);
      return answers[msg.type] ?? {};
    },
  };
}

const { createBridgePanel } = await import("../packages/extension/src/providers/bridge/popup.js");

/** Mount the bridge panel into a fresh window and hand back everything a test needs. */
async function mountBridge({ profiles = [] } = {}) {
  const window = popupWindow();
  const storage = fakeStorage(profiles.length ? { profiles } : {});
  const rec = recorder();
  const section = window.document.createElement("section");
  window.document.getElementById("panels").appendChild(section);
  const panel = withDom(window, () => createBridgePanel({ storage, send: rec.send }));
  withDom(window, () => panel.mount(section));
  await new Promise((r) => setTimeout(r, 0)); // the mount reads storage asynchronously
  return { window, section, panel, rec, storage, render: (s) => withDom(window, () => panel.render(s)) };
}

console.log("The popup shell:");

await check("popup.html holds NOTHING provider-specific", async () => {
  // The whole point of the seam. If a panel's markup creeps back in here, a fork has to edit this
  // file again and the conflict returns.
  const html = readFileSync(path.join(root, "packages/extension/popup.html"), "utf8");
  const body = html.slice(html.indexOf("<body>"));
  for (const id of ["profiles", "form", "saveProfile", "add", "token", "blockInput"]) {
    assert.equal(body.includes(`id="${id}"`), false, `popup.html still owns #${id}`);
  }
  assert.ok(body.includes('id="panels"'), "no mount point for panels");
  assert.ok(body.includes('id="reconnect"'), "the shell lost its reconnect button");
});

await check("the shell loads popup.js as a MODULE, or the imports never run", async () => {
  const html = readFileSync(path.join(root, "packages/extension/popup.html"), "utf8");
  assert.match(html, /<script[^>]+type="module"[^>]+src="popup\.js"/);
});

console.log("\nThe bridge panel:");

await check("it fills its own section — the shell provides an empty one", async () => {
  const { section } = await mountBridge();
  assert.ok(section.querySelector("#profiles"), "no profile list");
  assert.ok(section.querySelector("#form"), "no add/edit form");
  assert.ok(section.querySelector("#add"), "no add button");
});

await check("with no profiles it says so, rather than drawing nothing", async () => {
  // A blank panel and a working-but-empty panel look identical, and only one of them is fine.
  const { section } = await mountBridge();
  assert.match(section.querySelector("#profiles").textContent, /No profiles yet/);
});

await check("it reads configuration from STORAGE, not from the status snapshot", async () => {
  // A disabled profile has no connection, so the worker never reports it. Reading the list from
  // the snapshot would make switching a profile off delete it from the UI.
  const { section } = await mountBridge({
    profiles: [{ id: "p1", name: "Prod", agentUrl: "wss://a.test", enabled: false }],
  });
  assert.match(section.textContent, /Prod/, "a disabled profile vanished from the list");
  assert.match(section.textContent, /Off/);
});

await check("live state from the snapshot is joined onto the stored profile", async () => {
  const { section, render } = await mountBridge({
    profiles: [{ id: "p1", name: "Prod", agentUrl: "wss://a.test", enabled: true }],
  });
  render({ profiles: [{ id: "p1", connState: "connected", tabCount: 2 }] });
  assert.match(section.textContent, /Connected/);
  assert.match(section.textContent, /2 tabs/);
});

await check("a connected profile with no tabs reads 'idle', not '0 tabs'", async () => {
  const { section, render } = await mountBridge({
    profiles: [{ id: "p1", name: "Prod", agentUrl: "wss://a.test", enabled: true }],
  });
  render({ profiles: [{ id: "p1", connState: "connected", tabCount: 0 }] });
  assert.match(section.textContent, /idle/);
});

await check("the toggle saves through the worker", async () => {
  const { section, rec } = await mountBridge({
    profiles: [{ id: "p1", name: "Prod", agentUrl: "wss://a.test", enabled: true }],
  });
  section.querySelector(".switch input").click();
  await new Promise((r) => setTimeout(r, 0));
  const saved = rec.sent.filter((m) => m.type === "saveProfiles");
  assert.equal(saved.length, 1, "toggling sent no save");
  assert.equal(saved[0].profiles[0].enabled, false);
});

await check("Delete removes the row and saves", async () => {
  const { section, rec } = await mountBridge({
    profiles: [{ id: "p1", name: "Prod", agentUrl: "wss://a.test", enabled: true }],
  });
  [...section.querySelectorAll("button")].find((b) => b.textContent === "Delete").click();
  await new Promise((r) => setTimeout(r, 0));
  const saved = rec.sent.filter((m) => m.type === "saveProfiles");
  assert.deepEqual(saved.at(-1).profiles, []);
  assert.match(section.querySelector("#profiles").textContent, /No profiles yet/);
});

await check("the form saves a new profile, enabled, with an id", async () => {
  const { section, rec } = await mountBridge();
  section.querySelector("#add").click();
  assert.equal(section.querySelector("#form").classList.contains("hidden"), false, "form stayed hidden");
  section.querySelector("#name").value = "New one";
  section.querySelector("#url").value = "wss://b.test";
  section.querySelector("#token").value = "tok";
  section.querySelector("#saveProfile").click();
  await new Promise((r) => setTimeout(r, 0));
  const saved = rec.sent.filter((m) => m.type === "saveProfiles").at(-1);
  assert.equal(saved.profiles.length, 1);
  assert.equal(saved.profiles[0].agentUrl, "wss://b.test");
  assert.equal(saved.profiles[0].enabled, true);
  assert.ok(saved.profiles[0].id, "a profile with no id can never be matched to its connection");
});

await check("a profile with no URL is REFUSED — it could never connect", async () => {
  const { section, rec } = await mountBridge();
  section.querySelector("#add").click();
  section.querySelector("#name").value = "No url";
  section.querySelector("#saveProfile").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rec.sent.filter((m) => m.type === "saveProfiles").length, 0, "it saved anyway");
  assert.equal(section.querySelector("#form").classList.contains("hidden"), false, "the form closed");
});

await check("Edit fills the form from the profile it was opened on", async () => {
  const { section } = await mountBridge({
    profiles: [{ id: "p1", name: "Prod", agentUrl: "wss://a.test", accessToken: "s3cret", enabled: true }],
  });
  [...section.querySelectorAll("button")].find((b) => b.textContent === "Edit").click();
  assert.equal(section.querySelector("#name").value, "Prod");
  assert.equal(section.querySelector("#url").value, "wss://a.test");
  assert.equal(section.querySelector("#token").value, "s3cret");
  assert.equal(section.querySelector("#formTitle").textContent, "Edit profile");
});

await check("editing UPDATES rather than adding a second profile", async () => {
  const { section, rec } = await mountBridge({
    profiles: [{ id: "p1", name: "Prod", agentUrl: "wss://a.test", enabled: true }],
  });
  [...section.querySelectorAll("button")].find((b) => b.textContent === "Edit").click();
  section.querySelector("#name").value = "Renamed";
  section.querySelector("#saveProfile").click();
  await new Promise((r) => setTimeout(r, 0));
  const saved = rec.sent.filter((m) => m.type === "saveProfiles").at(-1);
  assert.equal(saved.profiles.length, 1, "editing created a duplicate");
  assert.equal(saved.profiles[0].name, "Renamed");
  assert.equal(saved.profiles[0].id, "p1", "the id changed, orphaning its connection");
});

await check("the input lock shows on the row, so it is never silently on", async () => {
  const { section } = await mountBridge({
    profiles: [{ id: "p1", name: "Prod", agentUrl: "wss://a.test", enabled: true, blockInput: true }],
  });
  assert.match(section.querySelector(".name").textContent, /🔒/);
});

await check("it scopes lookups to its own section, so two panels may share an id", async () => {
  // `document.getElementById` works today because the ids happen to be unique across the panels
  // that exist. That is an assumption about other people's code, and it breaks silently.
  const { window, section } = await mountBridge();
  const other = window.document.createElement("section");
  other.innerHTML = `<div id="profiles">a rival panel</div>`;
  window.document.getElementById("panels").appendChild(other);
  assert.notEqual(section.querySelector("#profiles").textContent, "a rival panel");
});

await check("render before mount does not throw", async () => {
  // The shell renders on a timer; a panel that mounted slowly must not crash the whole popup.
  const window = popupWindow();
  const panel = withDom(window, () => createBridgePanel({ storage: fakeStorage(), send: async () => ({}) }));
  withDom(window, () => panel.render({ profiles: [] }));
});


console.log("\nMounting several panels:");

/** Run the shell's own mount loop against a set of panels. Mirrors popup.js — see the note below. */
function mountAll(window, panels) {
  const root = window.document.getElementById("panels");
  for (const panel of panels) {
    const section = window.document.createElement("section");
    section.className = "panel";
    section.dataset.panel = panel.name;
    if (panel.summary) {
      const details = window.document.createElement("details");
      const summary = window.document.createElement("summary");
      summary.textContent = panel.summary;
      details.appendChild(summary);
      details.appendChild(section);
      root.appendChild(details);
    } else {
      root.appendChild(section);
    }
    try {
      panel.mount(section);
    } catch (err) {
      void err;
    }
  }
  return root;
}

const stubPanel = (name, over = {}) => ({
  name,
  mounted: false,
  mount(root) { this.mounted = true; root.textContent = name; },
  render() {},
  ...over,
});

await check("a panel declaring a `summary` is folded into a <details>", async () => {
  // The fork collapses the self-hosted bridge under "Advanced". Expressed by the panel list, not
  // by editing the panel — a fork must be able to demote a core panel without forking it.
  const window = popupWindow();
  const root = mountAll(window, [stubPanel("main"), stubPanel("extra", { summary: "Advanced" })]);
  const details = root.querySelector("details");
  assert.ok(details, "no <details> was created");
  assert.equal(details.querySelector("summary").textContent, "Advanced");
  assert.ok(details.querySelector('section[data-panel="extra"]'), "the panel is not inside it");
  assert.equal(root.querySelector('section[data-panel="main"]').closest("details"), null,
    "a panel with no summary was collapsed anyway");
});

await check("panels appear in the order they are listed", async () => {
  const window = popupWindow();
  const root = mountAll(window, [stubPanel("first"), stubPanel("second")]);
  const names = [...root.querySelectorAll("section[data-panel]")].map((s) => s.dataset.panel);
  assert.deepEqual(names, ["first", "second"]);
});

await check("one panel throwing on mount does not stop the next", async () => {
  // The same isolation the worker's registry has. A fork's half-finished panel must not blank the
  // one that works — and a blank popup is indistinguishable from a dead extension.
  const window = popupWindow();
  const good = stubPanel("good");
  mountAll(window, [stubPanel("bad", { mount() { throw new Error("bang"); } }), good]);
  assert.equal(good.mounted, true, "the second panel never mounted");
});

await check("the shell's real mount loop is the one this file models", async () => {
  // `mountAll` above is a COPY of popup.js's loop, because popup.js runs on import and needs a
  // Chrome global. A copy that drifts tests nothing, so pin the behaviours it claims to share.
  const src = readFileSync(path.join(root, "packages/extension/popup.js"), "utf8");
  assert.match(src, /panel\.summary/, "the shell no longer honours `summary`");
  assert.match(src, /createElement\("details"\)/, "the shell no longer builds a <details>");
  assert.match(src, /dataset\.panel = panel\.name/, "sections are no longer tagged with the panel name");
  assert.match(src, /try \{\s*panel\.mount\(section\);\s*\} catch/, "mount is no longer isolated");
  assert.match(src, /try \{\s*panel\.render\([\s\S]{0,40}\} catch/, "render is no longer isolated");
});

if (failures.length) {
  console.error(`\n✗ popup: ${failures.length} failed, ${pass} passed.`);
  for (const f of failures) console.error(`    ${f}`);
  process.exit(1);
}
console.log(`\n✅ popup: ${pass} checks passed.`);
