// The popup: sign in to Lumi, choose which workspaces this browser is offered to, keep a private
// blocklist — and, behind a disclosure, the original self-hosted bridge profiles.
//
// SIGN-IN RUNS HERE, NOT IN THE SERVICE WORKER, and that is a deliberate division. The device flow
// is a ten-minute human round-trip; a worker that has to stay alive across it is a worker that
// will be evicted in the middle of it. The popup owns the polling loop and hands the finished
// session over in one message. If the popup closes, the sign-in is simply abandoned — the code
// expires on its own and nothing is left behind.
//
// WHAT THIS SCREEN CANNOT DO is as important as what it can. It cannot share the browser and it
// cannot grant an agent permission: both live in Lumi, on the workspace's own Settings page, and
// both belong to this person there rather than here. Duplicating them into the popup would make
// the extension look like the place where access is decided, which it is not.
import { KEYS, resolveEndpoint } from "./src/lumi-config.js";
import { callFunction, startLogin } from "./src/lumi-auth.js";
import { listMyShips } from "./src/lumi-api.js";
import { parseOwnEntry } from "./src/lumi-blocklist.js";

const $ = (id) => document.getElementById(id);
const show = (el, on) => el.classList.toggle("hidden", !on);

const STATE_UI = {
  init: { cls: "warn", text: "Starting…" },
  connecting: { cls: "warn", text: "Connecting…" },
  connected: { cls: "ok", text: "Connected" },
  disconnected: { cls: "err", text: "Disconnected — retrying…" },
  signed_out: { cls: "err", text: "Signed out" },
  unauthorized: { cls: "err", text: "Refused — sign in again" },
};

let snapshot = { bridges: [], lumi: null, session: null, ships: [], lastError: "" };
let ships = [];
let chosen = new Set();
let blocklist = [];
let signingIn = null;

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => ({}));

async function refresh() {
  snapshot = (await send({ type: "getStatus" })) || snapshot;
  const store = await chrome.storage.local.get([KEYS.label, KEYS.blocklist, KEYS.pending]);
  if (document.activeElement !== $("label")) $("label").value = store[KEYS.label] || "";
  blocklist = Array.isArray(store[KEYS.blocklist]) ? store[KEYS.blocklist] : [];
  chosen = new Set(snapshot.ships || []);

  // Reopening the popup mid-handshake must show the code again, not the sign-in button. The
  // handshake lives in storage precisely because the popup is disposable — this is the read side
  // of that, and without it somebody who closed the popup would start a second login while the
  // first was still pending.
  const pending = store[KEYS.pending];
  if (pending && Date.now() < pending.expiresAt) {
    signingIn = { started: pending };
    $("displayCode").textContent = `${pending.userCode.slice(0, 4)}-${pending.userCode.slice(4)}`;
    $("verifyUrl").textContent = pending.verificationUrl ?? "";
    const left = Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000));
    $("signInState").textContent = `Waiting for approval… ${Math.floor(left / 60)}:${String(
      left % 60,
    ).padStart(2, "0")}`;
  } else if (signingIn && !pending) {
    // The worker finished (or gave up) while this popup was open.
    signingIn = null;
  }
  render();
}

function render() {
  const signedIn = !!snapshot.session;
  show($("signedOut"), !signedIn && !signingIn);
  show($("signingIn"), !!signingIn);
  show($("signedIn"), signedIn && !signingIn);

  if (signedIn) {
    const ui = STATE_UI[snapshot.lumi?.connState] || STATE_UI.connecting;
    $("dot").className = `dot ${ui.cls}`;
    let text = ui.text;
    if (snapshot.lumi?.connState === "connected") {
      const n = snapshot.lumi.tabCount;
      text += n ? ` · ${n} tab${n === 1 ? "" : "s"} in use` : " · idle";
    }
    $("stateText").textContent = text;
    $("who").textContent = snapshot.session.email
      ? `Signed in as ${snapshot.session.email}`
      : `Signed in as ${snapshot.session.uid}`;
    renderShips();
    renderBlocklist();
    const err = snapshot.lastError || "";
    $("error").textContent = err;
    show($("error"), !!err);
  }
  renderBridges();
}

function renderShips() {
  const list = $("ships");
  list.textContent = "";
  if (ships.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Loading your workspaces…";
    list.appendChild(p);
    return;
  }
  for (const ship of ships) {
    const row = document.createElement("div");
    row.className = `pick${chosen.has(ship.id) ? " on" : ""}`;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.style.width = "auto";
    box.checked = chosen.has(ship.id);
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = ship.name || ship.id;
    row.appendChild(box);
    row.appendChild(nm);
    row.addEventListener("click", (e) => {
      if (e.target !== box) box.checked = !box.checked;
      if (box.checked) chosen.add(ship.id);
      else chosen.delete(ship.id);
      // Removing a workspace here does NOT delete the row over there — that is a captain's or the
      // owner's act on the Browsers panel, and doing it silently from a checkbox would make the
      // two screens disagree about what exists. This is only "stop beating for that one".
      send({ type: "setShips", ships: [...chosen] }).then(refresh);
    });
    list.appendChild(row);
  }
}

function renderBlocklist() {
  const list = $("blocklist");
  list.textContent = "";
  for (const origin of blocklist) {
    const chip = document.createElement("div");
    chip.className = "chip";
    const t = document.createElement("span");
    t.style.flex = "1";
    t.textContent = origin;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.title = `Stop blocking ${origin}`;
    x.addEventListener("click", async () => {
      blocklist = blocklist.filter((o) => o !== origin);
      await send({ type: "setBlocklist", blocklist });
      renderBlocklist();
    });
    chip.appendChild(t);
    chip.appendChild(x);
    list.appendChild(chip);
  }
}

// ── sign-in ───────────────────────────────────────────────────────────────────
/**
 * Start a handshake and HAND IT TO THE WORKER, which does the polling.
 *
 * The popup cannot poll, and this is not a preference. Chrome destroys an extension popup the
 * instant it loses focus, and the next line here opens the approval tab — which takes focus. A
 * popup that owned the loop would be killed about a millisecond after starting it, the human would
 * approve on the web page, and the extension would sit there signed out forever.
 *
 * So the popup's whole job is: get a code, show it, hand it over, open the tab. Everything after
 * that survives the popup closing, because it is in storage and the worker's alarm re-enters it.
 */
$("signIn").addEventListener("click", async () => {
  const store = await chrome.storage.local.get(KEYS.endpoint);
  const endpoint = resolveEndpoint(store[KEYS.endpoint]);
  const label = $("label").value.trim() || "This browser";
  try {
    const started = await startLogin(endpoint, label);
    await send({
      type: "beginLogin",
      pending: {
        userCode: started.userCode,
        deviceCode: started.deviceCode,
        expiresAt: Date.now() + (started.expiresIn ?? 600) * 1000,
        // Kept so reopening the popup can still show where to go. The worker never reads it.
        verificationUrl: started.verificationUrl,
        label,
        endpoint,
      },
    });
    signingIn = { started };
    $("displayCode").textContent = started.displayCode;
    $("verifyUrl").textContent = started.verificationUrl;
    $("signInState").textContent = "Waiting for approval…";
    render();
    // Last, so the code is on screen before focus leaves — reopening the popup shows it again
    // anyway, but there is no reason to make somebody go looking for it.
    chrome.tabs.create({ url: started.verificationUrl });
  } catch (e) {
    signingIn = null;
    $("error").textContent = String(e?.message || e);
    show($("error"), true);
    render();
  }
});

$("cancelSignIn").addEventListener("click", async () => {
  await send({ type: "cancelLogin" });
  signingIn = null;
  await refresh();
});

async function loadShips() {
  if (!snapshot.session) return;
  const store = await chrome.storage.local.get(KEYS.endpoint);
  const endpoint = resolveEndpoint(store[KEYS.endpoint]);
  try {
    // The popup asks Crew directly rather than through the worker: it already has to be awake,
    // and a list of workspace names is not worth a message round-trip and a cache to go stale.
    const session = await chrome.storage.local.get(KEYS.session);
    const idToken = session[KEYS.session]?.idToken;
    if (!idToken) return;
    ships = await listMyShips(callFunction, endpoint, idToken);
    renderShips();
  } catch (e) {
    $("shipsNote").textContent = `Could not list your workspaces: ${e.message}`;
  }
}

$("label").addEventListener("change", async () => {
  await chrome.storage.local.set({ [KEYS.label]: $("label").value.trim() || "This browser" });
});

$("blockAdd").addEventListener("click", async () => {
  const parsed = parseOwnEntry($("blockEntry").value);
  if (!parsed.ok) {
    $("error").textContent = parsed.message;
    show($("error"), true);
    return;
  }
  const next = new Set(blocklist);
  for (const o of parsed.origins) next.add(o);
  blocklist = [...next].sort();
  await send({ type: "setBlocklist", blocklist });
  $("blockEntry").value = "";
  show($("error"), false);
  renderBlocklist();
});

$("reconnect").addEventListener("click", async () => {
  await send({ type: "reconnect" });
  setTimeout(refresh, 400);
});

$("signOut").addEventListener("click", async () => {
  await send({ type: "signOut" });
  ships = [];
  await refresh();
});

// ── the self-hosted bridge profiles: unchanged behaviour ──────────────────────
let profiles = [];
let editingId = null;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

async function loadProfiles() {
  const { profiles: stored } = await chrome.storage.local.get("profiles");
  profiles = Array.isArray(stored) ? stored : [];
  renderBridges();
}

function renderBridges() {
  const list = $("profiles");
  if (!list) return;
  const byId = new Map((snapshot.bridges || []).map((p) => [p.id, p]));
  list.textContent = "";
  if (profiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No bridges. The Lumi connection above needs none.";
    list.appendChild(empty);
    return;
  }
  for (const p of profiles) {
    const st = byId.get(p.id);
    const ui = p.enabled
      ? STATE_UI[st?.connState] || { cls: "warn", text: "Connecting…" }
      : { cls: "", text: "Off" };
    const row = document.createElement("div");
    row.className = "profile";

    const top = document.createElement("div");
    top.className = "top";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = (p.blockInput ? "🔒 " : "") + (p.name || "(unnamed)");
    const sw = document.createElement("label");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!p.enabled;
    cb.addEventListener("change", () => {
      p.enabled = cb.checked;
      persistProfiles();
    });
    const slider = document.createElement("span");
    slider.className = "slider";
    sw.appendChild(cb);
    sw.appendChild(slider);
    top.appendChild(name);
    top.appendChild(sw);
    row.appendChild(top);

    const url = document.createElement("div");
    url.className = "url";
    url.textContent = p.agentUrl || "(no url)";
    row.appendChild(url);

    const state = document.createElement("div");
    state.className = "state";
    const dot = document.createElement("span");
    dot.className = `dot ${ui.cls}`;
    const label = document.createElement("span");
    label.textContent = ui.text;
    state.appendChild(dot);
    state.appendChild(label);
    row.appendChild(state);

    const actions = document.createElement("div");
    actions.className = "actions";
    const edit = document.createElement("button");
    edit.className = "ghost";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openForm(p.id));
    const del = document.createElement("button");
    del.className = "ghost";
    del.textContent = "Delete";
    del.addEventListener("click", () => {
      profiles = profiles.filter((x) => x.id !== p.id);
      if (editingId === p.id) closeForm();
      persistProfiles();
    });
    actions.appendChild(edit);
    actions.appendChild(del);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

async function persistProfiles() {
  await send({ type: "saveProfiles", profiles });
  await refresh();
}

function openForm(id) {
  editingId = id ?? null;
  const p = id ? profiles.find((x) => x.id === id) : null;
  $("name").value = p?.name ?? "";
  $("url").value = p?.agentUrl ?? "";
  $("token").value = p?.accessToken ?? "";
  $("blockInput").checked = !!p?.blockInput;
  show($("form"), true);
}

function closeForm() {
  editingId = null;
  show($("form"), false);
}

$("add").addEventListener("click", () => openForm(null));
$("cancel").addEventListener("click", closeForm);
$("saveProfile").addEventListener("click", () => {
  const name = $("name").value.trim();
  const agentUrl = $("url").value.trim();
  const accessToken = $("token").value.trim();
  const blockInput = $("blockInput").checked;
  if (!agentUrl) return $("url").focus();
  if (editingId) {
    const p = profiles.find((x) => x.id === editingId);
    if (p) Object.assign(p, { name, agentUrl, accessToken, blockInput });
  } else {
    profiles.push({ id: uuid(), name: name || "Bridge", agentUrl, accessToken, enabled: true, blockInput });
  }
  closeForm();
  persistProfiles();
});

refresh().then(loadShips);
loadProfiles();
setInterval(() => {
  // Paused during sign-in: re-rendering under a live device code would replace the screen the
  // person is currently reading a code off.
  // Refreshes DURING sign-in too, which the previous version deliberately did not. That guard
  // existed to stop a re-render replacing the code somebody was reading — but the worker owns the
  // polling now, so refreshing is the only way this screen ever learns the login succeeded, and
  // `refresh()` re-reads the pending handshake so the code stays put.
  refresh();
}, 1500);
