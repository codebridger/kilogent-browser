// Talking to Kilogent Crew: the operations of its browser dispatcher (see `callFunction` in auth.js).
//
// ONE RECORD PER BROWSER, OWNED BY THE ACCOUNT, WRITTEN BY THE SERVER. This file used to write a
// row straight into Firestore on every workspace the browser was offered to, and beat on each one.
// Since PRFAQ-001 ("Browser in three short steps") a browser belongs to its owner's account, not to
// a workspace, and Crew creates and updates that one record itself. So every call here is a
// dispatcher operation, and the extension holds no Firestore code at all.
//
// THE NAME IS THE ONE THING A PERSON TYPES, and the server is the judge of it: unique per account,
// trimmed, any letter case. `checkBrowserName` below is only a friendly early answer so the popup
// can say "that's empty" without a round-trip — the server refuses the same things, and more.

/** Longest name the popup accepts. The server has the final say. */
export const NAME_MAX = 60;

/**
 * A friendly client-side check of a browser name, before asking the server.
 *
 * @param {string} raw         what the person typed
 * @param {string[]} [others]  names of this account's OTHER browsers, if the popup knows them
 * @returns {{ok:true, name:string} | {ok:false, message:string}}
 */
export function checkBrowserName(raw, others = []) {
  // Same normalisation as the server: trimmed, compared without letter case. Nothing stricter —
  // a name the server would accept must never be refused here, because the person cannot see why.
  const name = String(raw ?? "").trim();
  if (!name) return { ok: false, message: "Give this browser a name." };
  if (name.length > NAME_MAX) {
    return { ok: false, message: `Keep it to ${NAME_MAX} characters or fewer.` };
  }
  const key = name.toLowerCase();
  if ((others ?? []).some((other) => String(other ?? "").trim().toLowerCase() === key)) {
    return { ok: false, message: "You already have a browser with this name. Pick another one." };
  }
  return { ok: true, name };
}

/**
 * An error from a browser operation, with the server's own code kept.
 *
 * Crew puts the machine-readable reason in `details.code` — `name_required`, `name_taken` (with
 * `details.suggestion`, e.g. "Work Chrome (2)"), `browser_taken`, `browser_not_registered`. The
 * message is for people and may change, so nothing here branches on it.
 */
function withReason(e) {
  const details = e?.details ?? {};
  e.code = details.code || "";
  e.suggestion = details.suggestion || "";
  return e;
}

async function op(callFunction, endpoint, name, data, idToken) {
  try {
    return await callFunction(endpoint, name, data, idToken);
  } catch (e) {
    throw withReason(e);
  }
}

/** A suggested name from the device, e.g. "Chrome on MacBook". Null if the server has none. */
export async function suggestBrowserName(callFunction, endpoint, idToken, agentString) {
  const result = await op(callFunction, endpoint, "suggestBrowserName", { agentString }, idToken);
  return typeof result?.name === "string" && result.name ? result.name : null;
}

/**
 * Create (or claim again) this browser's account-level record, with its name.
 *
 * Idempotent on `browserId`: an existing install calling it again with the same name is a no-op on
 * the server, which is what lets an update re-register without a special path.
 */
export async function registerBrowser(callFunction, endpoint, idToken, identity) {
  return op(
    callFunction,
    endpoint,
    "registerBrowser",
    {
      browserId: identity.browserId,
      name: identity.name,
      agentString: (identity.agentString || "").slice(0, 400),
      extensionVersion: identity.extensionVersion || "",
    },
    idToken,
  );
}

export async function renameBrowser(callFunction, endpoint, idToken, browserId, name) {
  return op(callFunction, endpoint, "renameBrowser", { browserId, name }, idToken);
}

/**
 * The heartbeat — ONE per browser, not one per workspace.
 *
 * PRESENCE IS AN ABSENCE on the other side: a browser that is killed, slept or closed cannot say
 * "offline", so the staleness of the last beat IS the signal.
 *
 * The answer is the server's view: `{registered, name, paused, needsRename}`. It is how a rename
 * or a pause done on My browsers reaches this popup, and `registered: false` is how a browser
 * removed there learns it must be named again.
 */
export async function browserHeartbeat(callFunction, endpoint, idToken, beat) {
  return op(
    callFunction,
    endpoint,
    "browserHeartbeat",
    {
      browserId: beat.browserId,
      tabCount: beat.tabCount ?? 0,
      extensionVersion: beat.extensionVersion || "",
    },
    idToken,
  );
}

export async function setBrowserPaused(callFunction, endpoint, idToken, browserId, paused) {
  return op(callFunction, endpoint, "setBrowserPaused", { browserId, paused: !!paused }, idToken);
}

/**
 * Say "signed out" before the session is dropped, so My browsers can tell it apart from plain
 * offline. Only stamps the record; the next heartbeat or registration clears it. BEST EFFORT —
 * sign-out never waits on it succeeding.
 */
export async function signOutBrowser(callFunction, endpoint, idToken, browserId) {
  return op(callFunction, endpoint, "signOutBrowser", { browserId }, idToken);
}

/**
 * A ticket for ONE socket.
 *
 * Workspace-agnostic on purpose: a browser is a MACHINE serving its owner over one connection.
 * Whether an agent may drive it is decided per call, from the browser's links, by Crew — never here.
 */
export async function mintTicket(callFunction, endpoint, idToken, browserId) {
  const result = await callFunction(endpoint, "mintBrowserRelayTicket", { browserId }, idToken);
  if (!result?.ticket || !result?.relayUrl) throw new Error("Kilogent did not return a relay ticket.");
  return { ticket: result.ticket, relayUrl: result.relayUrl };
}
