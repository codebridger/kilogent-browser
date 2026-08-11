// The Kilogent panel — sign in, choose which workspaces this browser is offered to, keep a private
// blocklist.
//
// SIGN-IN STARTS HERE AND IS FINISHED BY THE WORKER, and that division is not a preference. Chrome
// destroys an extension popup the instant it loses focus, and the next thing sign-in does is open
// the approval tab — which takes focus. A popup that owned the polling loop would be killed about a
// millisecond after starting it, the human would approve on the web page, and the extension would
// sit there signed out forever. So this gets a code, shows it, hands it over, and opens the tab;
// everything after that survives the popup closing, because it is in storage and the worker's alarm
// re-enters it.
//
// WHAT THIS SCREEN CANNOT DO is as important as what it can. It cannot share the browser and it
// cannot grant an agent permission: both live in Kilogent, on the workspace's own Settings page,
// and both belong to this person there rather than here. Duplicating them into the popup would make
// the extension look like the place where access is decided, which it is not.
//
// The markup below is VERBATIM from what `popup.html` used to hold — the stylesheet is core and
// matches on these class names, so this is a move rather than a rewrite.

import { KEYS, resolveEndpoint } from "./config.js";
import { callFunction, startLogin } from "./auth.js";
import { listMyShips } from "./api.js";
import { parseOwnEntry } from "./blocklist.js";

const MARKUP = `
  <!-- signed out -->
  <section id="signedOut">
    <p class="note">Sign in with the Kilogent account you already have. This does not share your browser with anyone — you choose that afterwards.</p>
    <div class="row"><button id="signIn">Sign in with Kilogent</button></div>
  </section>

  <!-- signing in: the device code -->
  <section id="signingIn" class="hidden">
    <p class="note">Approve this browser in the Kilogent tab that just opened. If it did not open, go to the address below and enter this code.</p>
    <p class="code" id="displayCode">----&#8209;----</p>
    <p class="note" id="verifyUrl"></p>
    <div class="state"><span class="dot warn"></span><span id="signInState">Waiting for approval…</span></div>
    <div class="row"><button id="cancelSignIn" class="secondary">Cancel</button></div>
  </section>

  <!-- signed in -->
  <section id="signedIn" class="hidden">
    <div class="state"><span class="dot" id="dot"></span><span id="stateText">Connecting…</span></div>
    <p class="who" id="who"></p>

    <label for="label">This browser is called</label>
    <input id="label" placeholder="Work laptop" />

    <label>Offer it to</label>
    <div class="list" id="ships"></div>
    <p class="note" id="shipsNote">Sharing and permission are set in Kilogent, on each workspace's Settings › Browsers.</p>

    <label>Never open these</label>
    <div class="row" style="margin-top: 4px">
      <input id="blockEntry" placeholder="bank.example.com" />
      <button id="blockAdd" class="ghost">Block</button>
    </div>
    <div class="list" id="blocklist"></div>
    <p class="note">Your list always applies. A workspace can add to it and can never shorten it.</p>

    <p class="err hidden" id="error"></p>
    <div class="row">
      <button id="signOut" class="secondary">Sign out</button>
    </div>
  </section>
`;

const STATE_UI = {
  init: { cls: "warn", text: "Starting…" },
  connecting: { cls: "warn", text: "Connecting…" },
  connected: { cls: "ok", text: "Connected" },
  disconnected: { cls: "err", text: "Disconnected — retrying…" },
  signed_out: { cls: "err", text: "Signed out" },
  unauthorized: { cls: "err", text: "Refused — sign in again" },
};

/** @param {{storage: any, send: Function, openTab: Function}} deps */
export function createKilogentPanel(deps) {
  let el = null;
  let snapshot = { kilogent: null, session: null, ships: [], lastError: "" };
  let ships = [];
  let chosen = new Set();
  let blocklist = [];
  let signingIn = null;

  const $ = (id) => el.querySelector(`#${id}`);
  const doc = () => el.ownerDocument;
  const show = (target, on) => target.classList.toggle("hidden", !on);

  function draw() {
    const signedIn = !!snapshot.session;
    show($("signedOut"), !signedIn && !signingIn);
    show($("signingIn"), !!signingIn);
    show($("signedIn"), signedIn && !signingIn);
    if (!signedIn) return;

    const ui = STATE_UI[snapshot.kilogent?.connState] || STATE_UI.connecting;
    $("dot").className = `dot ${ui.cls}`;
    let text = ui.text;
    if (snapshot.kilogent?.connState === "connected") {
      const n = snapshot.kilogent.tabCount;
      text += n ? ` · ${n} tab${n === 1 ? "" : "s"} in use` : " · idle";
    }
    $("stateText").textContent = text;
    $("who").textContent = snapshot.session.email
      ? `Signed in as ${snapshot.session.email}`
      : `Signed in as ${snapshot.session.uid}`;
    drawShips();
    drawBlocklist();
    const err = snapshot.lastError || "";
    $("error").textContent = err;
    show($("error"), !!err);
  }

  function drawShips() {
    const list = $("ships");
    list.textContent = "";
    if (ships.length === 0) {
      const p = doc().createElement("p");
      p.className = "empty";
      p.textContent = "Loading your workspaces…";
      list.appendChild(p);
      return;
    }
    for (const ship of ships) {
      const row = doc().createElement("div");
      row.className = `pick${chosen.has(ship.id) ? " on" : ""}`;
      const box = doc().createElement("input");
      box.type = "checkbox";
      box.style.width = "auto";
      box.checked = chosen.has(ship.id);
      const nm = doc().createElement("span");
      nm.className = "nm";
      nm.textContent = ship.name || ship.id;
      row.appendChild(box);
      row.appendChild(nm);
      row.addEventListener("click", (e) => {
        if (e.target !== box) box.checked = !box.checked;
        if (box.checked) chosen.add(ship.id);
        else chosen.delete(ship.id);
        // Removing a workspace here does NOT delete the row over there — that is the owner's act on
        // the Browsers panel, and doing it silently from a checkbox would make the two screens
        // disagree about what exists. This is only "stop beating for that one".
        deps.send({ type: "setShips", ships: [...chosen] }).then(reload);
      });
      list.appendChild(row);
    }
  }

  function drawBlocklist() {
    const list = $("blocklist");
    list.textContent = "";
    for (const origin of blocklist) {
      const chip = doc().createElement("div");
      chip.className = "chip";
      const t = doc().createElement("span");
      t.style.flex = "1";
      t.textContent = origin;
      const x = doc().createElement("span");
      x.className = "x";
      x.textContent = "×";
      x.title = `Stop blocking ${origin}`;
      x.addEventListener("click", async () => {
        blocklist = blocklist.filter((o) => o !== origin);
        await deps.send({ type: "setBlocklist", blocklist });
        drawBlocklist();
      });
      chip.appendChild(t);
      chip.appendChild(x);
      list.appendChild(chip);
    }
  }

  /** Read the parts of our state that live in storage rather than in the status snapshot. */
  async function reload() {
    const store = await deps.storage.get([KEYS.label, KEYS.blocklist, KEYS.pending]);
    if (doc().activeElement !== $("label")) $("label").value = store[KEYS.label] || "";
    blocklist = Array.isArray(store[KEYS.blocklist]) ? store[KEYS.blocklist] : [];
    chosen = new Set(snapshot.ships || []);

    // Reopening the popup mid-handshake must show the code again, not the sign-in button. The
    // handshake lives in storage precisely because the popup is disposable — this is the read side
    // of that, and without it somebody who closed the popup would start a SECOND login while the
    // first was still pending.
    const pending = store[KEYS.pending];
    if (pending && Date.now() < pending.expiresAt) {
      signingIn = { started: pending };
      $("displayCode").textContent = `${pending.userCode.slice(0, 4)}-${pending.userCode.slice(4)}`;
      $("verifyUrl").textContent = pending.verificationUrl ?? "";
      const left = Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000));
      $("signInState").textContent = `Waiting for approval… ${Math.floor(left / 60)}:${String(
        left % 60
      ).padStart(2, "0")}`;
    } else if (signingIn && !pending) {
      // The worker finished, or gave up, while this popup was open.
      signingIn = null;
    }
    draw();
  }

  async function loadShips() {
    if (!snapshot.session) return;
    const store = await deps.storage.get([KEYS.endpoint, KEYS.session]);
    const endpoint = resolveEndpoint(store[KEYS.endpoint]);
    try {
      // Asked directly rather than through the worker: the popup is already awake, and a list of
      // workspace names is not worth a message round-trip and a cache to go stale.
      const idToken = store[KEYS.session]?.idToken;
      if (!idToken) return;
      ships = await listMyShips(callFunction, endpoint, idToken);
      drawShips();
    } catch (e) {
      $("shipsNote").textContent = `Could not list your workspaces: ${e.message}`;
    }
  }

  async function beginSignIn() {
    const store = await deps.storage.get(KEYS.endpoint);
    const endpoint = resolveEndpoint(store[KEYS.endpoint]);
    const label = $("label").value.trim() || "This browser";
    try {
      const started = await startLogin(endpoint, label);
      await deps.send({
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
      draw();
      // LAST, so the code is on screen before focus leaves. Reopening the popup shows it again
      // anyway, but there is no reason to make somebody go looking for it.
      deps.openTab(started.verificationUrl);
    } catch (e) {
      signingIn = null;
      $("error").textContent = String(e?.message || e);
      show($("error"), true);
      draw();
    }
  }

  return {
    name: "kilogent",

    mount(root) {
      el = root;
      el.innerHTML = MARKUP;

      $("signIn").addEventListener("click", () => void beginSignIn());
      $("cancelSignIn").addEventListener("click", async () => {
        await deps.send({ type: "cancelLogin" });
        signingIn = null;
        await reload();
      });
      $("label").addEventListener("change", async () => {
        await deps.storage.set({ [KEYS.label]: $("label").value.trim() || "This browser" });
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
        await deps.send({ type: "setBlocklist", blocklist });
        $("blockEntry").value = "";
        show($("error"), false);
        drawBlocklist();
      });
      $("signOut").addEventListener("click", async () => {
        await deps.send({ type: "signOut" });
        ships = [];
        await reload();
      });

      void reload();
    },

    render(next) {
      if (!el) return;
      const wasSignedOut = !snapshot.session;
      snapshot = next || snapshot;
      draw();
      // Never rejects: the shell calls this on a timer and does not await it, so a rejection here
      // would be an unhandled one every 1500 ms.
      void reload().catch(() => {});
      if (wasSignedOut && snapshot.session) void loadShips();
    },
  };
}
