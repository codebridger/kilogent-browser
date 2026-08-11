// Talking to Kilogent Crew: two callables, and the browser's own row in Firestore.
//
// The row is written DIRECTLY by this extension rather than by a callable, and that is the whole
// security model rather than a shortcut: `firestore.rules` pins `ownerUid` to `request.auth.uid`,
// so a browser can only ever claim the person who signed in. No amount of bugs here can forge a
// different owner, because the check is not in this file.
//
// Firestore REST rather than the SDK, for `kilogent-auth.js`'s reason — no build step. The mapping to
// and from Firestore's typed JSON is small enough to write out, and writing it out is what keeps
// the extension a directory you can read.
//
// THE DATABASE IS NAMED. Crew's data lives in `crew`, never `(default)` — a write to the wrong one
// silently lands in Support's database and is watched by nothing.

const FIRESTORE = "https://firestore.googleapis.com/v1";
const DATABASE = "crew";

/** Fields the extension maintains on its own row. Must agree with `liveFields()` in the rules —
 *  a field written and not listed there makes `hasOnly()` reject the whole write, so the browser
 *  silently stops beating and shows offline while its socket is up and working. */
const LIVE_FIELDS = ["label", "agentString", "extensionVersion", "lastSeenAt", "tabCount"];

function docPath(projectId, shipId, browserId) {
  return `${FIRESTORE}/projects/${projectId}/databases/${DATABASE}/documents/ships/${shipId}/browsers/${browserId}`;
}

/** JS → Firestore's typed JSON. Integers must go as `integerValue` STRINGS; a number sent as
 *  `doubleValue` fails `is int` in the rules, which reads as a permission bug and is a type bug. */
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object") {
    return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toValue(x)])) } };
  }
  return { stringValue: String(v) };
}

function fromValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromValue);
  if ("mapValue" in v) return fromFields(v.mapValue.fields ?? {});
  return null;
}

function fromFields(fields) {
  return Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, fromValue(v)]));
}

async function firestore(url, idToken, init) {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${idToken}`, ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error?.message || `Firestore ${res.status}`);
    err.httpStatus = res.status;
    // The §15.30 inference, and the reason this is surfaced rather than swallowed: a browser has
    // no removal event and no field left to read, so the news that it was thrown off a Ship
    // arrives as a 403 on its own row. Sound ONLY because it is scoped to that one document.
    err.denied = res.status === 403 || body?.error?.status === "PERMISSION_DENIED";
    err.missing = res.status === 404;
    throw err;
  }
  return body;
}

/** Read this browser's row on one Ship. Null when it does not exist yet. */
export async function getBrowserDoc(idToken, projectId, shipId, browserId) {
  try {
    const doc = await firestore(docPath(projectId, shipId, browserId), idToken);
    return fromFields(doc.fields);
  } catch (e) {
    if (e.missing) return null;
    throw e;
  }
}

/**
 * Create this browser's row. `shared: false` is not a default that happened — it is the design:
 * a browser that is merely CONNECTED is not a browser agents may drive, and nothing about
 * installing an extension should imply otherwise.
 *
 * `createDocument` rather than a PATCH, because the rules genuinely distinguish the two and the
 * create branch is the one that pins `ownerUid`. It fails with 409 if the row already exists,
 * which is the right answer — the caller updates instead.
 */
export async function createBrowserDoc(idToken, projectId, shipId, browserId, identity, ownerUid) {
  const parent = `${FIRESTORE}/projects/${projectId}/databases/${DATABASE}/documents/ships/${shipId}/browsers`;
  const fields = {
    ownerUid: toValue(ownerUid),
    label: toValue(identity.label),
    shared: toValue(false),
    lastSeenAt: toValue(Date.now()),
    createdAt: toValue(Date.now()),
    ...(identity.agentString ? { agentString: toValue(identity.agentString.slice(0, 400)) } : {}),
    ...(identity.extensionVersion ? { extensionVersion: toValue(identity.extensionVersion) } : {}),
  };
  return firestore(`${parent}?documentId=${encodeURIComponent(browserId)}`, idToken, {
    method: "POST",
    body: JSON.stringify({ fields }),
  });
}

/**
 * The heartbeat. PRESENCE IS AN ABSENCE on the other side — a browser that is killed, slept or
 * closed cannot write "offline", so the staleness of this timestamp IS the signal, and Crew reads
 * anything older than 90 seconds as gone.
 *
 * The update mask names only `liveFields()`, so a heartbeat can never carry a sharing field by
 * accident — which is the reason the rules keep those two lists apart.
 */
export async function heartbeat(idToken, projectId, shipId, browserId, live) {
  const fields = {};
  const mask = [];
  for (const key of LIVE_FIELDS) {
    if (live[key] === undefined) continue;
    fields[key] = toValue(live[key]);
    mask.push(`updateMask.fieldPaths=${key}`);
  }
  if (mask.length === 0) return null;
  return firestore(`${docPath(projectId, shipId, browserId)}?${mask.join("&")}`, idToken, {
    method: "PATCH",
    body: JSON.stringify({ fields }),
  });
}

/** Which workspaces may this person lend their browser to? Filtered server-side by membership. */
export async function listMyShips(callFunction, endpoint, idToken) {
  const result = await callFunction(endpoint, "listMyShipsForBrowser", {}, idToken);
  return Array.isArray(result?.ships) ? result.ships : [];
}

/**
 * A ticket for ONE socket.
 *
 * Ship-agnostic on purpose: a browser is a MACHINE serving every Ship its owner belongs to over
 * one connection, so there is no shipId to send. Whether an agent may drive it is decided per
 * call, from live documents, by Crew — never here.
 */
export async function mintTicket(callFunction, endpoint, idToken, browserId) {
  const result = await callFunction(endpoint, "mintBrowserRelayTicket", { browserId }, idToken);
  if (!result?.ticket || !result?.relayUrl) throw new Error("Kilogent did not return a relay ticket.");
  return { ticket: result.ticket, relayUrl: result.relayUrl };
}

/**
 * Make sure this browser has a row on each chosen Ship, and beat on the ones it has.
 *
 * A DENIAL IS NOT AN ERROR HERE, it is the removal signal (§15.30): the Ship dropped this browser,
 * or dropped this person, and the answer is to stop offering it there while leaving every other
 * Ship alone. Returned rather than thrown so one revoked Ship cannot take down the heartbeat for
 * the rest — which is exactly the bug that made a temporary revocation permanent for daemons.
 */
export async function syncShips(idToken, projectId, shipIds, browserId, identity, ownerUid, live) {
  const removed = [];
  const failed = [];
  for (const shipId of shipIds) {
    try {
      const existing = await getBrowserDoc(idToken, projectId, shipId, browserId);
      if (!existing) {
        await createBrowserDoc(idToken, projectId, shipId, browserId, identity, ownerUid);
        continue;
      }
      await heartbeat(idToken, projectId, shipId, browserId, live);
    } catch (e) {
      if (e.denied) removed.push(shipId);
      else failed.push({ shipId, message: String(e.message || e) });
    }
  }
  return { removed, failed };
}
