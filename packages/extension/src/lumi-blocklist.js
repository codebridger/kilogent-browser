// The two-level blocklist, level 2 — and the level that actually decides.
//
// One list lives in Lumi, set by a captain, and arrives on `session_open`. The other lives here,
// on the machine of the person whose browser this is, and is edited in the popup. THE EFFECTIVE
// POLICY IS THE UNION, so a captain can only ever ADD to what the owner has chosen to block. That
// asymmetry is what "the extension's list wins" means, and it is the only version of it that is
// enforceable — the extension is where the tab is.
//
// MATCHED ON EXACT ORIGIN, never a prefix or a substring. `https://bank.com.evil.com` merely
// BEGINS with something familiar, and a prefix match would hand it the exemption. This has to
// agree with Crew's `isOriginBlocked` exactly, and `scripts/lumi-contract-harness.mjs` asserts it
// does against the real published implementation — the two live in different repos with nothing
// linking them at compile time, so agreement has to be tested rather than assumed.
//
// ENFORCED HERE RATHER THAN AT THE RELAY, and that is not an optimisation. A `browser_act` click
// on a link navigates without any tool naming a URL, so checking a tool ARGUMENT is a speed bump.
// Crew checks the argument too, so a refusal is clean and legible when it can be; this is the part
// that holds when it cannot.

/**
 * The origin of a URL — scheme + host + port, lowercased — or null if it is not a usable one.
 *
 * Anything that is not http(s) returns null and is treated as BLOCKED. A `javascript:` or `data:`
 * URL has no origin to compare, and silently allowing it would be a hole shaped exactly like the
 * one this exists to close.
 */
export function originOf(url) {
  if (typeof url !== "string" || url.trim() === "") return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin.toLowerCase();
  } catch (e) {
    return null;
  }
}

/** Is this URL blocked by these origins? A URL with no usable origin FAILS CLOSED. */
export function isBlocked(url, origins) {
  const origin = originOf(url);
  if (origin === null) return true;
  if (!origins || origins.length === 0) return false;
  return origins.some((entry) => originOf(entry) === origin);
}

/**
 * Ship list ∪ owner list, canonicalised and de-duplicated.
 *
 * Entries are canonicalised THROUGH `originOf`, so a Ship entry and an owner entry that name the
 * same site collapse to one — and anything unparseable is dropped rather than kept as a string
 * that could never match. Dropping is safe in a way that keeping is not: an entry that cannot be
 * turned into an origin can never equal one either, so it was already inert.
 */
export function effectiveBlocklist(shipOrigins, ownOrigins) {
  const out = new Set();
  for (const entry of [...(shipOrigins ?? []), ...(ownOrigins ?? [])]) {
    const origin = originOf(entry);
    if (origin) out.add(origin);
  }
  return [...out].sort();
}

/**
 * One line the owner typed → the origins to store.
 *
 * A BARE HOST BECOMES TWO ENTRIES, the same decision Crew's own editor makes and for the same
 * reason: an origin carries its scheme, so storing only `https://bank.example.com` leaves
 * `http://bank.example.com` open. Somebody typing a host means "this site", never "this site over
 * https".
 */
export function parseOwnEntry(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, message: "Type an address to block." };
  if (text.includes("://")) {
    const origin = originOf(text);
    if (!origin) return { ok: false, message: "Only http:// and https:// addresses can be blocked." };
    return { ok: true, origins: [origin] };
  }
  const secure = originOf(`https://${text}`);
  const plain = originOf(`http://${text}`);
  if (!secure || !plain) return { ok: false, message: `"${text}" is not an address.` };
  return { ok: true, origins: [secure, plain] };
}
