// Everything the relay needs to start, resolved once and validated loudly.
//
// A relay that starts with a missing secret and discovers it on the first real dispatch is a
// relay that fails during someone's job rather than during a deploy. Every required value is
// checked here, and every refusal names the variable and shows the command that fixes it.

import { resolveAuthProvider, type AuthProvider } from "./providers/index.js";
import { MIN_KEY_LENGTH } from "./providers/secrets.js";

export interface RelayConfig {
  /** One port serves both faces: the control plane over HTTP, and the extensions' WS upgrade at
   *  `/ws`. One port means one Cloudflare ingress rule and one thing to get wrong. */
  port: number;
  /** Loopback by default. `cloudflared` runs on the box and is the only thing that should reach
   *  this process; the tunnel is what publishes it. Overridable so a container can bind 0.0.0.0,
   *  which is a deliberate act with a name rather than something that happens by accident. */
  bindHost: string;

  /**
   * The bearer token the caller sends in a header on every dispatch.
   *
   * It lives here rather than only inside the provider because the HEALTH REPORTER needs it too:
   * the relay pushes its own metrics upstream with this token, which is a use no provider is
   * involved in. Whether it is also what gates the control plane is the provider's decision —
   * every built-in one says yes, and one that authenticates a caller some other way is free not to.
   */
  controlKey: string;

  /**
   * Who verifies a browser, and who may reach the control plane. Selected by `RELAY_AUTH`.
   *
   * Built here rather than in `server.ts` so that every refusal a misconfiguration can produce
   * comes out of one function, before anything binds a port — which is this file's whole job.
   */
  auth: AuthProvider;

  maxBrowsers: number;
  sessionIdleMs: number;
  /** How long a drain waits for in-flight commands before hanging up anyway. */
  drainGraceMs: number;

  /** Where to POST health reports. Absent disables reporting (a dev box). */
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

  if (!controlKey) {
    throw new Error(
      "RELAY_CONTROL_KEY is not set. Whatever dispatches commands authenticates to the control\n" +
        "plane with this token; refusing to start without it. Generate one and put it in the\n" +
        "relay's environment:\n\n" +
        "  openssl rand -hex 32\n\n" +
        "The same value has to reach the caller."
    );
  }
  if (controlKey.length < MIN_KEY_LENGTH) {
    throw new Error(
      `RELAY_CONTROL_KEY must be at least ${MIN_KEY_LENGTH} characters.\n` +
        "`openssl rand -hex 32` produces 64."
    );
  }

  // Whatever else a provider needs is ITS refusal to make, and it makes it now rather than on
  // somebody's first click.
  const auth = resolveAuthProvider(env);

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
    auth,
    maxBrowsers: num(env, "RELAY_MAX_BROWSERS", 2000),
    sessionIdleMs: num(env, "RELAY_SESSION_IDLE_MS", 30 * 60_000),
    drainGraceMs: num(env, "RELAY_DRAIN_GRACE_MS", 20_000),
    healthUrl,
    healthIntervalMs: num(env, "RELAY_HEALTH_INTERVAL_MS", 30_000),
    instanceId: env.RELAY_INSTANCE_ID ?? "relay",
  };
}
