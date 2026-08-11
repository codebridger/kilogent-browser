// Popup: the shell, and nothing panel-specific.
//
// It creates one `<section>` per registered panel, mounts each, and drives them all from a single
// status poll. Everything a particular way of connecting needs to show — profiles, sign-in, a
// workspace list — belongs to that provider's panel under `src/providers/`, so `popup.html` and
// this file are core and a fork edits neither.
//
// ONE POLL, NOT ONE PER PANEL. Two panels asking the worker for status on their own timers is two
// wake-ups of a service worker that is trying to stay evicted, for one answer both of them want.

import { PANELS } from "./src/providers/panels.js";

const REFRESH_MS = 1500;

/** Never throws: a popup that dies because the worker was mid-restart is a popup that looks broken
 *  for the one second it takes to come back. */
async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch {
    return {};
  }
}

const deps = { storage: chrome.storage.local, send };

const root = document.getElementById("panels");
const panels = PANELS.map((make) => make(deps));

for (const panel of panels) {
  const section = document.createElement("section");
  section.className = "panel";
  section.dataset.panel = panel.name;
  root.appendChild(section);
  try {
    panel.mount(section);
  } catch (err) {
    // One panel failing to mount must not leave the others blank — the same isolation the worker's
    // registry applies, for the same reason.
    console.error(`[popup] ${panel.name} failed to mount:`, err);
  }
}

async function refresh() {
  const snapshot = await send({ type: "getStatus" });
  for (const panel of panels) {
    try {
      panel.render(snapshot || {});
    } catch (err) {
      console.error(`[popup] ${panel.name} failed to render:`, err);
    }
  }
}

document.getElementById("reconnect").addEventListener("click", async () => {
  await send({ type: "reconnect" });
  setTimeout(refresh, 400);
});

refresh();
setInterval(refresh, REFRESH_MS);
