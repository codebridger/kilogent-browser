// Which configuration values are secrets, and how to print one without leaking it.
//
// THE OLD RULE WAS THE VARIABLE'S NAME ENDING IN `KEY`, and it was a rule about the two variables
// that existed when it was written rather than about what a secret IS. The moment the `token`
// provider added `RELAY_TOKENS`, `config list` — the one command documented as safe to run while
// screen-sharing — printed a browser's credential in full. Worse than a ticket key leaking, in one
// respect: a static token never expires, so the only remedy is editing the file and restarting.
//
// So the rule is a LIST, and adding a provider means adding its variable here. That is a
// maintenance burden on purpose: an allow-list of what is safe would fail open on the next one.

/** Every variable whose value is, or contains, a credential. */
const SECRET_VARS = new Set(["RELAY_CONTROL_KEY", "RELAY_TICKET_KEY", "RELAY_TOKEN", "RELAY_TOKENS"]);

export function isSecretVar(name: string): boolean {
  return SECRET_VARS.has(name);
}

/** Enough to tell two values apart, not enough to use. Short values are hidden entirely rather
 *  than mostly shown — an eight-character secret would otherwise be printed almost whole. */
function maskSecret(value: string): string {
  if (value.length === 0) return "";
  if (value.length < 16) return "…".repeat(8);
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * Mask a value for display.
 *
 * `RELAY_TOKENS` is `name=secret,name=secret`, and the NAMES are the useful half — they are the
 * browser ids a dispatch is addressed to. So its structure is preserved and only the secrets are
 * masked; anything unparseable is masked whole, because a value this function does not understand
 * is a value it cannot prove is safe.
 */
export function maskConfigValue(name: string, value: string): string {
  if (!isSecretVar(name)) return value;
  if (name !== "RELAY_TOKENS") return maskSecret(value);

  const entries = value.split(",");
  const out: string[] = [];
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) return maskSecret(value); // not the shape we know — mask the lot
    out.push(`${entry.slice(0, eq)}=${maskSecret(entry.slice(eq + 1).trim())}`);
  }
  return out.join(",");
}
