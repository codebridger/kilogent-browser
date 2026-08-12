// The `bridge` panel — the self-hosted profiles UI.
//
// Lifted out of `popup.js` when the popup grew its provider seam. The MARKUP BELOW IS VERBATIM
// from what `popup.html` used to hold, deliberately: the stylesheet is core and matches on these
// class names, so moving the markup rather than rewriting it is what keeps the popup looking
// identical through a change nothing can screenshot.
//
// Everything is scoped to the panel's own root element. `document.getElementById` would still work
// today — the ids are unique across the two panels that exist — and it is exactly the assumption
// that breaks the first time a fork's panel picks the same id as one of ours.

const MARKUP = `
  <div id="profiles" class="profiles"></div>

  <div class="row">
    <button id="add">+ Add profile</button>
  </div>

  <div id="form" class="hidden">
    <h2 id="formTitle">New profile</h2>
    <label for="name">Name</label>
    <input id="name" type="text" placeholder="e.g. Prod bridge" spellcheck="false" />

    <label for="url">Agent URL</label>
    <input id="url" type="text" placeholder="wss://your-bridge.example/rbm-ws" spellcheck="false" />
    <div class="hint">The VM bridge WebSocket endpoint (wss://).</div>

    <label for="token">Access Token</label>
    <input id="token" type="password" placeholder="paste the shared token" spellcheck="false" />

    <label class="check"><input id="blockInput" type="checkbox" /> Block my input while the agent is acting</label>
    <div class="hint">Suppresses your mouse/keyboard on this profile's tabs during agent activity, so you can't interfere mid-action.</div>

    <div class="row">
      <button id="saveProfile">Save</button>
      <button id="cancel" class="secondary">Cancel</button>
    </div>
  </div>
`;

const STATE_UI = {
  init: { cls: "warn", text: "Starting…" },
  unconfigured: { cls: "warn", text: "Not configured" },
  connecting: { cls: "warn", text: "Connecting…" },
  connected: { cls: "ok", text: "Connected" },
  auth_error: { cls: "err", text: "Auth failed — check the token" },
  disconnected: { cls: "err", text: "Disconnected — retrying…" },
};

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

/**
 * @param {{storage: any, send: (msg: any) => Promise<any>}} deps
 *   Injected so the panel has no Chrome global in it and a test can drive it.
 */
export function createBridgePanel(deps) {
  /** Local working copy. The snapshot carries live CONNECTION state; this is the CONFIGURATION,
   *  and they are different things — a profile exists while disabled and has no connection. */
  let profiles = [];
  let editingId = null;
  let el = null;
  let latest = null;

  const $ = (id) => el.querySelector(`#${id}`);
  /** The panel's OWN document, taken from its root rather than from the global.
   *
   *  Not fastidiousness: `draw()` also runs from an async storage callback, and a global that was
   *  correct when `mount` was called is not guaranteed to be the one in scope by then. Asking the
   *  element it is drawing into is always right, and it makes the panel loadable in any document. */
  const doc = () => el.ownerDocument;

  async function persist() {
    await deps.send({ type: "saveProfiles", profiles });
    draw();
  }

  function toggle(id, enabled) {
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    p.enabled = enabled;
    persist();
  }

  function remove(id) {
    profiles = profiles.filter((x) => x.id !== id);
    if (editingId === id) closeForm();
    persist();
  }

  function openForm(id) {
    editingId = id ?? null;
    const p = id ? profiles.find((x) => x.id === id) : null;
    $("formTitle").textContent = p ? "Edit profile" : "New profile";
    $("name").value = p?.name ?? "";
    $("url").value = p?.agentUrl ?? "";
    $("token").value = p?.accessToken ?? "";
    $("blockInput").checked = !!p?.blockInput;
    $("form").classList.remove("hidden");
  }

  function closeForm() {
    editingId = null;
    $("form").classList.add("hidden");
  }

  function saveForm() {
    const name = $("name").value.trim();
    const agentUrl = $("url").value.trim();
    const accessToken = $("token").value.trim();
    const blockInput = $("blockInput").checked;
    if (!agentUrl) {
      $("url").focus();
      return;
    }
    if (editingId) {
      const p = profiles.find((x) => x.id === editingId);
      if (p) Object.assign(p, { name, agentUrl, accessToken, blockInput });
    } else {
      profiles.push({
        id: uuid(),
        name: name || "Bridge",
        agentUrl,
        accessToken,
        enabled: true,
        blockInput,
      });
    }
    closeForm();
    persist();
  }

  /** Draw the list from `profiles` (configuration) joined to `latest` (live state). */
  function draw() {
    const byId = new Map((latest?.profiles || []).map((p) => [p.id, p]));
    const list = $("profiles");
    list.textContent = "";

    if (profiles.length === 0) {
      const empty = doc().createElement("div");
      empty.className = "empty";
      empty.textContent = "No profiles yet. Add one to connect a bridge.";
      list.appendChild(empty);
      return;
    }

    for (const p of profiles) {
      const st = byId.get(p.id);
      const ui = p.enabled
        ? STATE_UI[st?.connState] || STATE_UI.connecting
        : { cls: "", text: "Off" };

      const row = doc().createElement("div");
      row.className = "profile";

      const top = doc().createElement("div");
      top.className = "top";

      const name = doc().createElement("div");
      name.className = "name";
      name.textContent = (p.blockInput ? "🔒 " : "") + (p.name || "(unnamed)");
      top.appendChild(name);

      const sw = doc().createElement("label");
      sw.className = "switch";
      const cb = doc().createElement("input");
      cb.type = "checkbox";
      cb.checked = !!p.enabled;
      cb.addEventListener("change", () => toggle(p.id, cb.checked));
      const slider = doc().createElement("span");
      slider.className = "slider";
      sw.appendChild(cb);
      sw.appendChild(slider);
      top.appendChild(sw);
      row.appendChild(top);

      const url = doc().createElement("div");
      url.className = "url";
      url.textContent = p.agentUrl || "(no url)";
      row.appendChild(url);

      const state = doc().createElement("div");
      state.className = "state";
      if (ui.cls) state.innerHTML = `<span class="dot ${ui.cls}"></span>`;
      const label = doc().createElement("span");
      let txt = ui.text;
      if (p.enabled && st?.connState === "connected") {
        txt += st.tabCount ? ` · ${st.tabCount} tab${st.tabCount === 1 ? "" : "s"}` : " · idle";
      }
      label.textContent = txt;
      state.appendChild(label);
      row.appendChild(state);

      const actions = doc().createElement("div");
      actions.className = "actions";
      const edit = doc().createElement("button");
      edit.className = "ghost";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => openForm(p.id));
      const del = doc().createElement("button");
      del.className = "ghost";
      del.textContent = "Delete";
      del.addEventListener("click", () => remove(p.id));
      actions.appendChild(edit);
      actions.appendChild(del);
      row.appendChild(actions);

      list.appendChild(row);
    }
  }

  return {
    name: "bridge",

    mount(root) {
      el = root;
      el.innerHTML = MARKUP;
      $("add").addEventListener("click", () => openForm(null));
      $("cancel").addEventListener("click", closeForm);
      $("saveProfile").addEventListener("click", saveForm);
      // The configuration is read from storage, NOT from the status snapshot: a profile exists
      // while it is switched off, and the worker only reports the ones it has connections for.
      deps.storage.get("profiles").then((store) => {
        profiles = Array.isArray(store.profiles) ? store.profiles : [];
        draw();
      });
    },

    render(snapshot) {
      latest = snapshot;
      if (el) draw();
    },
  };
}
