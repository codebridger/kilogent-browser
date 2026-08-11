// Signing in to Kilogent from an MV3 service worker, over REST and nothing else.
//
// WHY REST RATHER THAN THE FIREBASE SDK. This package has no package.json, no bundler and no
// build step — you load the directory and it runs — and keeping it that way is most of the reason
// a security-conscious customer can read what they are about to give control of their browser to.
// The whole of what we need from Firebase Auth is two POSTs: exchange a custom token, and refresh
// an expired one. That is worth ~120 lines; it is not worth a build pipeline.
//
// AND `onAuthStateChanged` IS NOT USED, deliberately, even where the SDK is available. It does not
// fire reliably in an MV3 service worker (firebase-js-sdk#8482, open since 2024), and a worker
// that waits for a callback which never comes looks exactly like a worker that is signed out. The
// session is persisted by hand and read at module load, so a cold start knows who it is
// synchronously.
//
// NOTHING HERE GRANTS ACCESS TO ANYTHING. A Kilogent session lets this browser offer itself; whether
// an agent may drive it is three separate locks held by other people, re-checked per call.

import { KEYS, resolveEndpoint } from "./kilogent-config.js";

/** Refresh this far before expiry. One minute is the alarm period, so five gives four attempts. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Call a Crew callable over its HTTP shape.
 *
 * Callables wrap the payload in `{data}` and answer `{result}` or `{error}`, and the error carries
 * a `status` string (`UNAUTHENTICATED`, `NOT_FOUND`, …). Surfacing that status matters more here
 * than the message: `pollBrowserLogin` answers `NOT_FOUND` for a handshake that expired, was
 * claimed, or never existed, and the caller has to tell that apart from a network blip — one means
 * start again, the other means try again.
 */
export async function callFunction(endpoint, name, data, idToken) {
  const res = await fetch(`${resolveEndpoint(endpoint)}/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idToken ? { authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify({ data: data ?? {} }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    /* a non-JSON body is a proxy or an outage; handled below as a status-less failure */
  }
  if (!res.ok || body?.error) {
    const err = new Error(body?.error?.message || `${name} failed (HTTP ${res.status})`);
    err.status = body?.error?.status || "";
    err.httpStatus = res.status;
    throw err;
  }
  return body?.result;
}

// ── the device handshake ──────────────────────────────────────────────────────────────────────

/** Ask Crew for a code. Unauthenticated by construction — there is no session yet. */
export async function startLogin(endpoint, label) {
  return callFunction(endpoint, "startBrowserLogin", { label });
}

// `pollUntilApproved()` USED TO LIVE HERE, and its deletion is the fix for a bug that would have
// made sign-in fail every single time.
//
// It let a CALLER own the polling loop, and the caller was the popup. Chrome destroys an extension
// popup the moment it loses focus, and the line right after starting a login opens the approval
// tab — which takes focus. So the loop was killed about a millisecond after it began: the human
// approved on the web page, and the extension never collected the session.
//
// The loop now lives in the service worker (`pollPending()` in sw.js), driven off a handshake kept
// in `chrome.storage.local` so that an evicted worker resumes it from the alarm rather than losing
// it. This function is gone rather than left unused because an exported helper that does exactly
// the wrong thing is an invitation to reintroduce the bug.

// ── the Firebase session ──────────────────────────────────────────────────────────────────────

/**
 * Trade the custom token for a session. `returnSecureToken` is what makes the response carry a
 * refresh token; without it this browser would be signed out an hour later with no way back.
 */
export async function exchangeCustomToken(apiKey, customToken) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message || "Could not complete sign-in.");
  return {
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    expiresAt: Date.now() + Number(body.expiresIn ?? 3600) * 1000,
  };
}

/**
 * Refresh an expiring session.
 *
 * `INVALID_REFRESH_TOKEN` / `TOKEN_EXPIRED` / `USER_DISABLED` are FINAL: the session is gone and
 * no amount of retrying brings it back. They are marked so the caller signs out and says so,
 * because the alternative — a worker retrying a dead token every minute forever — is a browser
 * that looks connected, does nothing, and gives no one a reason to look.
 */
export async function refreshSession(apiKey, refreshToken) {
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    },
  );
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const reason = String(body?.error?.message || "");
    const err = new Error(reason || "Could not refresh the Kilogent session.");
    err.fatal = /INVALID_REFRESH_TOKEN|TOKEN_EXPIRED|USER_DISABLED|USER_NOT_FOUND/.test(reason);
    throw err;
  }
  return {
    idToken: body.id_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000,
  };
}

/** Is this session close enough to expiry to be worth refreshing? */
export function needsRefresh(session, now = Date.now()) {
  if (!session?.refreshToken) return false;
  return !session.idToken || now >= (session.expiresAt ?? 0) - REFRESH_SKEW_MS;
}

// ── persistence ───────────────────────────────────────────────────────────────────────────────

/**
 * The whole session, as one stored object.
 *
 * `{idToken, refreshToken, expiresAt, uid, email, apiKey, projectId}` — the last two arrive from
 * the approval, so this object is genuinely everything the extension needs to talk to Kilogent. A
 * partial write is worse than none: a stored refresh token with no apiKey can never be redeemed.
 */
export async function loadSession(storage) {
  const store = await storage.get(KEYS.session);
  const session = store?.[KEYS.session];
  return session && session.refreshToken && session.apiKey ? session : null;
}

export async function saveSession(storage, session) {
  await storage.set({ [KEYS.session]: session });
}

export async function clearSession(storage) {
  await storage.remove([KEYS.session, KEYS.ships]);
}

/**
 * A valid id token, refreshed if it is about to lapse.
 *
 * Returns null rather than throwing when the session is gone, because every caller's answer to
 * that is the same — stop, and let the popup say "signed out" — while a throw would have to be
 * caught identically at each of them.
 */
export async function getIdToken(storage, { onSignedOut } = {}) {
  const session = await loadSession(storage);
  if (!session) return null;
  if (!needsRefresh(session)) return session.idToken;
  try {
    const fresh = await refreshSession(session.apiKey, session.refreshToken);
    await saveSession(storage, { ...session, ...fresh });
    return fresh.idToken;
  } catch (e) {
    if (e.fatal) {
      await clearSession(storage);
      onSignedOut?.(e.message);
      return null;
    }
    // A transient failure keeps the session: the token may still be valid for minutes, and
    // throwing it away over one failed request would sign somebody out because their train went
    // into a tunnel.
    return session.idToken ?? null;
  }
}
