// Telling Crew how the box is doing, every 30 seconds.
//
// PUSH, NOT PULL, and the reason is the tunnel. Crew is a set of Cloud Functions with no fixed
// egress and no reason to know how many relays exist; the relay knows exactly one URL. A pull
// would also mean the health of the box depends on the box being reachable, which is precisely
// the case where you most want the last report you did get.
//
// The endpoint is an `onRequest` with shared-key auth rather than an `onCall`, because a relay is
// not a Firebase principal — it holds no Firebase credential by design (see ticket.ts) — and an
// `onCall` with no auth is a public write.

import type { RelayMetrics } from "./metrics.js";
import type { BrowserHub } from "./hub.js";

export interface HealthReporterOptions {
  url: string | null;
  intervalMs: number;
  controlKey: string;
  instanceId: string;
  version: string;
  hub: BrowserHub;
  metrics: RelayMetrics;
  log?: (msg: string) => void;
}

export class HealthReporter {
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;

  constructor(private readonly opts: HealthReporterOptions) {}

  start(): void {
    if (!this.opts.url) {
      this.opts.log?.("[health] RELAY_HEALTH_URL unset — not reporting (fine for a dev box)");
      return;
    }
    // Report once at startup so a restart is visible immediately rather than up to 30 s later —
    // the interval after a crash-loop is exactly when someone is watching.
    void this.report();
    this.timer = setInterval(() => void this.report(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The single consumer that closes the metrics window — see `RelayMetrics.snapshot`. */
  private async report(): Promise<void> {
    const { url, controlKey, hub, metrics } = this.opts;
    if (!url) return;
    const snapshot = metrics.snapshot(hub.size, hub.inFlight(), true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${controlKey}`,
        },
        body: JSON.stringify({
          instanceId: this.opts.instanceId,
          version: this.opts.version,
          ...snapshot,
        }),
        // Strictly shorter than the interval. A report that outlives its own period would stack
        // requests on a box that is already struggling — which is the only time it happens.
        signal: AbortSignal.timeout(Math.min(10_000, Math.max(2_000, this.opts.intervalMs - 5_000))),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (this.consecutiveFailures > 0) {
        this.opts.log?.(`[health] reporting recovered after ${this.consecutiveFailures} failure(s)`);
      }
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      // Log the first failure and then back off logarithmically. A relay that cannot reach Crew
      // still works perfectly for every browser attached to it — the tunnel is a different path
      // from the one dispatches arrive on — so this is a monitoring gap, not an outage, and
      // filling the disk with it would turn it into one.
      const n = this.consecutiveFailures;
      if (n === 1 || n === 10 || n % 100 === 0) {
        this.opts.log?.(
          `[health] report failed (${n} in a row): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}
