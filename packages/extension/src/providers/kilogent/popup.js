// The Kilogent panel — sign in, name this browser, then see its status and pause it.
//
// THREE SHORT STEPS (PRFAQ-001): sign in with Kilogent → approve the code → name the browser. That
// is the whole setup. Which agents may use this browser is chosen in Kilogent, on the agent's page,
// and the popup links to "My browsers" for everything about access. It used to ask which
// workspaces to offer the browser to; that choice moved to where the agent is set up.
//
// SIGN-IN STARTS HERE AND IS FINISHED BY THE WORKER, and that division is not a preference. Chrome
// destroys an extension popup the instant it loses focus, and the next thing sign-in does is open
// the approval tab — which takes focus. A popup that owned the polling loop would be killed about a
// millisecond after starting it. So this gets a code, shows it, hands it over, and opens the tab;
// everything after that survives the popup closing, because it is in storage and the worker's alarm
// re-enters it.
//
// PAUSE ALL AGENTS is the one access control that lives here too, on purpose: it must work when
// Kilogent is not open. The worker stores it and refuses relay commands itself while it is on.

import { BUILD_LABEL, KEYS, MY_BROWSERS_PATH, resolveEndpoint } from "./config.js";
import { callFunction, startLogin } from "./auth.js";
import { checkBrowserName, suggestBrowserName, NAME_MAX } from "./api.js";
import { parseOwnEntry } from "./blocklist.js";

// THIS PANEL'S OWN STYLES. A panel owns its markup, so it owns the rules for it too. Scoped to this
// section, because core's `.err` is a red DOT and this panel's `.err` is a line of text.
const STYLE = `
  <style>
    [data-panel="kilogent"] .note { color: #8889; font-size: 11px; margin: 6px 0 0; }
    [data-panel="kilogent"] .state { display: flex; align-items: center; gap: 6px; font-size: 12px; margin: 8px 0; }
    [data-panel="kilogent"] .dot { margin: 0; flex: none; }
    [data-panel="kilogent"] .code {
      font: 600 20px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.14em; text-align: center; margin: 10px 0 4px;
    }
    [data-panel="kilogent"] .list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    [data-panel="kilogent"] .pick {
      display: flex; align-items: center; gap: 8px;
      border: 1px solid #8883; border-radius: 8px; padding: 7px 9px; cursor: pointer;
    }
    [data-panel="kilogent"] .pick.on { border-color: #2563eb; background: #2563eb14; }
    [data-panel="kilogent"] .pick .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    [data-panel="kilogent"] .chip {
      display: flex; align-items: center; gap: 6px;
      border: 1px solid #8883; border-radius: 6px; padding: 4px 8px;
      font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    [data-panel="kilogent"] .chip .x { cursor: pointer; color: #dc2626; font-weight: 700; }
    [data-panel="kilogent"] .who { font-size: 11px; color: #8889; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    [data-panel="kilogent"] p.err { background: none; color: #dc2626; font-size: 11px; margin-top: 8px; }
    [data-panel="kilogent"] .name { font-size: 15px; font-weight: 600; margin: 4px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    [data-panel="kilogent"] .linkish { background: none; border: none; color: #2563eb; padding: 0; cursor: pointer; font: inherit; font-size: 11px; text-decoration: underline; width: auto; }
    [data-panel="kilogent"] .paused { border: 1px solid #d97706; background: #d9770614; border-radius: 8px; padding: 7px 9px; font-size: 12px; margin: 8px 0; }
    [data-panel="kilogent"] button.danger { background: #dc2626; color: #fff; }
  </style>
`;

const MARKUP = `${STYLE}
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

  <!-- naming: required right after sign-in, and again when the server asks -->
  <section id="naming" class="hidden">
    <label for="nameInput" id="nameTitle">Name this browser</label>
    <p class="note" id="nameWhy">You pick browsers by name in Kilogent, so each of yours needs its own.</p>
    <input id="nameInput" maxlength="${NAME_MAX}" placeholder="Work Chrome" autocomplete="off" />
    <p class="err hidden" id="nameError"></p>
    <div class="row hidden" id="suggestRow"><button id="useSuggestion" class="ghost"></button></div>
    <div class="row">
      <button id="nameDone">Done</button>
      <button id="nameCancel" class="secondary hidden">Cancel</button>
    </div>
    <p class="who" id="nameWho"></p>
    <!-- The way out when this is the wrong account. Naming is required to USE the browser, never to
         leave: a name step with no exit traps whoever signed in as the wrong person. -->
    <div class="row"><button id="nameSignOut" class="linkish">Not you? Sign out</button></div>
  </section>

  <!-- signed in and named -->
  <section id="signedIn" class="hidden">
    <p class="name" id="browserName"></p>
    <div class="state"><span class="dot" id="dot"></span><span id="stateText">Connecting…</span></div>
    <p class="who" id="who"></p>
    <div class="row" style="margin-top: 4px">
      <button id="rename" class="linkish">Rename</button>
      <button id="myBrowsers" class="linkish">My browsers in Kilogent</button>
    </div>

    <div class="paused hidden" id="pausedNote">All agents are paused on this browser. They can't do anything here until you resume.</div>
    <div class="row"><button id="pause" class="danger">Pause all agents</button></div>
    <p class="note">Works even when Kilogent is not open. Choose which agents can use this browser on the agent's page in Kilogent.</p>

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
  connected: { cls: "ok", text: "Online" },
  disconnected: { cls: "err", text: "Disconnected — retrying…" },
  signed_out: { cls: "err", text: "Signed out" },
  unauthorized: { cls: "err", text: "Refused — sign in again" },
};

/** @param {{storage: any, send: Function, openTab: Function, buildLabel?: string|null}} deps */
export function createKilogentPanel(deps) {
  let el = null;
  let snapshot = { kilogent: null, session: null, browser: null, lastError: "" };
  let blocklist = [];
  let signingIn = null;
  /**
   * The naming form's own state. `editing` is a rename the person asked for (it can be
   * cancelled); otherwise the form is shown because the browser NEEDS a name and cannot be skipped.
   */
  let naming = { editing: false, busy: false, prefilled: false };
  /** Names the server refused as taken during this popup's life — the friendly client check. */
  const takenNames = [];

  const $ = (id) => el.querySelector(`#${id}`);
  const show = (target, on) => target.classList.toggle("hidden", !on);

  function needsNameStep() {
    const b = snapshot.browser;
    return !!snapshot.session && (naming.editing || !!b?.needsName || !!b?.needsRename);
  }

  function draw() {
    const signedIn = !!snapshot.session;
    const nameStep = !signingIn && needsNameStep();
    show($("signedOut"), !signedIn && !signingIn);
    show($("signingIn"), !!signingIn);
    show($("naming"), signedIn && nameStep);
    show($("signedIn"), signedIn && !signingIn && !nameStep);
    if (!signedIn) return;
    if (nameStep) return drawNaming();

    const b = snapshot.browser || {};
    $("browserName").textContent = b.name || "This browser";
    const ui = STATE_UI[snapshot.kilogent?.connState] || STATE_UI.connecting;
    $("dot").className = `dot ${b.paused ? "warn" : ui.cls}`;
    let text = ui.text;
    if (snapshot.kilogent?.connState === "connected") {
      const n = snapshot.kilogent.tabCount;
      text += b.paused ? " · agents paused" : n ? ` · ${n} tab${n === 1 ? "" : "s"} in use` : " · idle";
    }
    $("stateText").textContent = text;
    $("who").textContent = snapshot.session.email
      ? `Signed in as ${snapshot.session.email}`
      : `Signed in as ${snapshot.session.uid}`;
    show($("pausedNote"), !!b.paused);
    $("pause").textContent = b.paused ? "Resume agents" : "Pause all agents";
    $("pause").className = b.paused ? "" : "danger";
    drawBlocklist();
    const err = snapshot.lastError || "";
    $("error").textContent = err;
    show($("error"), !!err);
  }

  function drawNaming() {
    const b = snapshot.browser || {};
    if (naming.editing) {
      $("nameTitle").textContent = "Rename this browser";
      $("nameWhy").textContent = "You pick browsers by name in Kilogent, so each of yours needs its own.";
    } else if (b.needsRename) {
      $("nameTitle").textContent = "Give this browser a new name";
      $("nameWhy").textContent =
        `Kilogent called it "${b.name}" because it had no name of its own, or another of your browsers had the same one. It keeps working meanwhile.`;
    } else {
      $("nameTitle").textContent = "Name this browser";
      $("nameWhy").textContent = "You pick browsers by name in Kilogent, so each of yours needs its own.";
    }
    show($("nameCancel"), naming.editing);
    const who = snapshot.session?.email || snapshot.session?.uid || "";
    $("nameWho").textContent = who ? `Signed in as ${who}` : "";
    const check = checkBrowserName($("nameInput").value, takenNames);
    $("nameDone").disabled = naming.busy || !check.ok;
    if (!naming.prefilled) void prefillName();
  }

  /** One click to finish: prefill with the current name or the server's suggestion. */
  async function prefillName() {
    naming.prefilled = true;
    const b = snapshot.browser || {};
    if (b.name && (naming.editing || b.needsRename)) {
      if (!$("nameInput").value) $("nameInput").value = b.name;
      return drawNaming();
    }
    try {
      const store = await deps.storage.get([KEYS.endpoint, KEYS.session]);
      const idToken = store[KEYS.session]?.idToken;
      if (!idToken) return;
      // Asked directly rather than through the worker: the popup is awake, and a suggestion is not
      // worth a message round-trip.
      const suggestion = await suggestBrowserName(
        callFunction,
        resolveEndpoint(store[KEYS.endpoint]),
        idToken,
        (globalThis.navigator?.userAgent || "").slice(0, 400),
      );
      if (suggestion && !$("nameInput").value) $("nameInput").value = suggestion;
    } catch {
      /* no suggestion: the person types one, which is fine */
    }
    drawNaming();
  }

  function nameError(message, suggestion) {
    $("nameError").textContent = message;
    show($("nameError"), !!message);
    show($("suggestRow"), !!suggestion);
    if (suggestion) {
      $("useSuggestion").textContent = `Use "${suggestion}"`;
      $("useSuggestion").dataset.name = suggestion;
    }
  }

  async function submitName() {
    const check = checkBrowserName($("nameInput").value, takenNames);
    if (!check.ok) return nameError(check.message, "");
    naming.busy = true;
    drawNaming();
    let answer;
    try {
      answer = await deps.send({ type: "setName", name: check.name });
    } catch (e) {
      answer = { ok: false, message: String(e?.message || e) };
    }
    naming.busy = false;
    if (!answer?.ok) {
      if (answer?.code === "name_taken") {
        takenNames.push(check.name);
        nameError("You already have a browser with this name. Pick another one.", answer.suggestion);
      } else if (answer?.code === "name_required") {
        nameError("Give this browser a name.", "");
      } else {
        nameError(answer?.message || "Could not save the name. Try again.", "");
      }
      return drawNaming();
    }
    nameError("", "");
    naming = { editing: false, busy: false, prefilled: false };
    snapshot = {
      ...snapshot,
      browser: { ...(snapshot.browser || {}), name: answer.name, needsName: false, needsRename: false, registered: true },
    };
    draw();
  }

  function drawBlocklist() {
    const list = $("blocklist");
    list.textContent = "";
    const doc = el.ownerDocument;
    for (const origin of blocklist) {
      const chip = doc.createElement("div");
      chip.className = "chip";
      const t = doc.createElement("span");
      t.style.flex = "1";
      t.textContent = origin;
      const x = doc.createElement("span");
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
    const store = await deps.storage.get([KEYS.blocklist, KEYS.pending]);
    blocklist = Array.isArray(store[KEYS.blocklist]) ? store[KEYS.blocklist] : [];

    // Reopening the popup mid-handshake must show the code again, not the sign-in button. The
    // handshake lives in storage precisely because the popup is disposable.
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

  async function beginSignIn() {
    const store = await deps.storage.get([KEYS.endpoint, KEYS.label]);
    const endpoint = resolveEndpoint(store[KEYS.endpoint]);
    // Only a hint for the approval page. The name itself is asked for after sign-in.
    const label = store[KEYS.label] || "This browser";
    try {
      const started = await startLogin(endpoint, label);
      await deps.send({
        type: "beginLogin",
        pending: {
          userCode: started.userCode,
          deviceCode: started.deviceCode,
          expiresAt: Date.now() + (started.expiresIn ?? 600) * 1000,
          // Kept so reopening the popup can still show where to go, and so the worker can learn
          // the web app's origin for the "My browsers" link.
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
      // LAST, so the code is on screen before focus leaves.
      deps.openTab(started.verificationUrl);
    } catch (e) {
      signingIn = null;
      $("error").textContent = String(e?.message || e);
      show($("error"), true);
      draw();
    }
  }

  async function openMyBrowsers() {
    const store = await deps.storage.get(KEYS.appOrigin);
    const origin = store[KEYS.appOrigin];
    if (!origin) {
      $("error").textContent = "Sign out and in again to get the My browsers link.";
      show($("error"), true);
      return;
    }
    deps.openTab(`${origin}${MY_BROWSERS_PATH}`);
  }

  return {
    name: "kilogent",

    mount(root) {
      el = root;
      el.innerHTML = MARKUP;

      // WHICH KILOGENT THIS BUILD SIGNS IN TO, said on the screen where the person signs in. The
      // development and production builds install side by side and are otherwise identical here.
      // `deps.buildLabel` exists for the test; the extension always uses the build's own label.
      const label = deps.buildLabel !== undefined ? deps.buildLabel : BUILD_LABEL;
      if (label) {
        const tag = el.ownerDocument.createElement("p");
        tag.className = "note";
        tag.id = "buildLabel";
        tag.textContent = `${label} build — signs in to Kilogent's ${label.toLowerCase()} environment, not production.`;
        el.prepend(tag);
      }

      $("signIn").addEventListener("click", () => void beginSignIn());
      $("cancelSignIn").addEventListener("click", async () => {
        await deps.send({ type: "cancelLogin" });
        signingIn = null;
        await reload();
      });

      $("nameInput").addEventListener("input", () => {
        nameError("", "");
        drawNaming();
      });
      $("nameInput").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !$("nameDone").disabled) void submitName();
      });
      $("nameDone").addEventListener("click", () => void submitName());
      $("useSuggestion").addEventListener("click", () => {
        $("nameInput").value = $("useSuggestion").dataset.name || "";
        nameError("", "");
        void submitName();
      });
      $("nameCancel").addEventListener("click", () => {
        naming = { editing: false, busy: false, prefilled: false };
        $("nameInput").value = "";
        nameError("", "");
        draw();
      });
      $("rename").addEventListener("click", () => {
        naming = { editing: true, busy: false, prefilled: false };
        $("nameInput").value = "";
        draw();
      });
      $("myBrowsers").addEventListener("click", () => void openMyBrowsers());

      $("pause").addEventListener("click", async () => {
        const next = !snapshot.browser?.paused;
        const answer = await deps.send({ type: "setPaused", paused: next });
        snapshot = { ...snapshot, browser: { ...(snapshot.browser || {}), paused: answer?.paused ?? next } };
        draw();
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
      const signOut = async () => {
        // Only disconnects. The browser stays on My browsers, offline, with its links; signing in
        // again brings it back. Removing it is a deliberate act there, not here.
        await deps.send({ type: "signOut" });
        naming = { editing: false, busy: false, prefilled: false };
        $("nameInput").value = "";
        nameError("", "");
        await reload();
      };
      $("signOut").addEventListener("click", () => void signOut());
      $("nameSignOut").addEventListener("click", () => void signOut());

      void reload();
    },

    render(next) {
      if (!el) return;
      snapshot = next || snapshot;
      draw();
      // Never rejects: the shell calls this on a timer and does not await it.
      void reload().catch(() => {});
    },
  };
}
