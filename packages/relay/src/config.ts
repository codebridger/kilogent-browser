// Everything the relay needs to start, resolved once and validated loudly.
//
// A relay that starts with a missing secret and discovers it on the first real dispatch is a
// relay that fails during someone's job rather than during a deploy. Every required value is
// checked here, and every refusal names the variable and shows the command that fixes it.

export interface RelayConfig {
  /** One port serves both faces: the control plane over HTTP, and the extensions' WS upgrade at
   *  `/ws`. One port means one Cloudflare ingress rule and one thing to get wrong. */
  port: number;
  /** Loopback by default. `cloudflared` runs on the box and is the only thing that should reach
   *  this process; the tunnel is what publishes it. Overridable so a container can bind 0.0.0.0,
   *  which is a deliberate act with a name rather than something that happens by accident. */
  bindHost: string;

  /**
   * TWO KEYS, AND THEY MUST DIFFER.
   *
   * `controlKey` is a bearer token Crew sends in a header on every dispatch — over the tunnel,
   * through Cloudflare, hundreds of times a minute, into anything that logs a request. `ticketKey`
   * is a SIGNING key: it never leaves this process and Crew's, and whoever holds it can mint a
   * ticket, connect as somebody else's browser, and receive that person's dispatches.
   *
   * A signing key must never be the thing you put in a header. Sharing one would make the leak
   * with the largest exposure surface also the leak with the worst consequence.
   */
  controlKey: string;
  ticketKey: string;

  maxBrowsers: number;
  sessionIdleMs: number;
  /** How long a drain waits for in-flight commands before hanging up anyway. */
  drainGraceMs: number;

  /** Crew's `crewBrowserRelayHealth` endpoint. Absent disables reporting (a dev box). */
  healthUrl: string | null;
  healthIntervalMs: number;

  /** Free-text name for this box, so a report identifies WHICH relay when there are two. */
  instanceId: string;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function loadConfig(env = process.env): RelayConfig {
  const controlKey = env.RELAY_CONTROL_KEY ?? "";
  const ticketKey = env.RELAY_TICKET_KEY ?? "";

  if (!controlKey) {
    throw new Error(
      "RELAY_CONTROL_KEY is not set. Lumi Crew authenticates to the control plane with this\n" +
        "token; refusing to start without it. Generate one and put it in the relay's environment:\n\n" +
        "  openssl rand -hex 32\n\n" +
        "The same value goes into Secret Manager as CREW_BROWSER_RELAY_KEY."
    );
  }
  if (!ticketKey) {
    throw new Error(
      "RELAY_TICKET_KEY is not set. This is the key browser tickets are SIGNED with; without it\n" +
        "no extension could ever connect. Generate one and put it in the relay's environment:\n\n" +
        "  openssl rand -hex 32\n\n" +
        "The same value goes into Secret Manager as CREW_BROWSER_TICKET_KEY.\n" +
        "Use a DIFFERENT value from RELAY_CONTROL_KEY — see config.ts for why."
    );
  }
  if (controlKey === ticketKey) {
    throw new Error(
      "RELAY_CONTROL_KEY and RELAY_TICKET_KEY are the same value. One is sent in a header on\n" +
        "every dispatch; the other signs the tickets that let a browser prove who it is. Sharing\n" +
        "one means the credential with the widest exposure is also the one that can impersonate\n" +
        "any connected browser. Generate a second one."
    );
  }
  if (controlKey.length < 32 || ticketKey.length < 32) {
    throw new Error(
      "RELAY_CONTROL_KEY and RELAY_TICKET_KEY must each be at least 32 characters.\n" +
        "`openssl rand -hex 32` produces 64."
    );
  }

  const healthUrl = env.RELAY_HEALTH_URL?.trim() || null;
  if (healthUrl && !/^https:\/\//.test(healthUrl) && !/^http:\/\/127\.0\.0\.1(:|\/)/.test(healthUrl)) {
    throw new Error(
      `RELAY_HEALTH_URL must be https:// (or http://127.0.0.1 for a local emulator), got ${healthUrl}.\n` +
        "The report carries the control key in a header."
    );
  }

  return {
    port: num(env, "RELAY_PORT", 8787),
    bindHost: env.RELAY_BIND_HOST ?? "127.0.0.1",
    controlKey,
    ticketKey,
    maxBrowsers: num(env, "RELAY_MAX_BROWSERS", 2000),
    sessionIdleMs: num(env, "RELAY_SESSION_IDLE_MS", 30 * 60_000),
    drainGraceMs: num(env, "RELAY_DRAIN_GRACE_MS", 20_000),
    healthUrl,
    healthIntervalMs: num(env, "RELAY_HEALTH_INTERVAL_MS", 30_000),
    instanceId: env.RELAY_INSTANCE_ID ?? "relay",
  };
}
