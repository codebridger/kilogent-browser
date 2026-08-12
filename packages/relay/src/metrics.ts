// What "is the box coping?" actually looks like on a $5 burstable VM.
//
// NOT CPU. A burstable instance is idle by design and its throttling shows up as latency long
// before its CPU percentage looks wrong — by the time the graph is alarming, the browsers have
// been timing out for ten minutes. The four signals here are the ones that move first:
//
//   • file descriptors — every browser is one socket is one fd, and the default soft limit of
//     ~1024 caps you near 950 browsers and then fails inside `accept` as EMFILE, which reads in a
//     log like a network fault rather than a limit. The limit is READ from the process, not
//     assumed, so raising it in the unit file is visible here and forgetting to is too.
//   • event-loop lag — the direct measure of "this process is late", which is what a throttled
//     burst credit balance and a GC pause and an oversized frame all look like from the inside.
//   • bandwidth — the one thing on a cheap box that produces a surprise BILL rather than an
//     outage, and screenshots are large.
//   • RSS — 1.9 GB total on the current box, shared with whatever else is on it.

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { readdirSync, readFileSync } from "node:fs";

export interface MetricsSnapshot {
  /** Seconds since the process started. */
  uptimeSec: number;
  browsers: number;
  commandsInFlight: number;
  /** Cumulative since start. */
  commandsDispatched: number;
  bytesIn: number;
  bytesOut: number;
  /** Bytes since the previous snapshot — the number that maps to a monthly allowance. */
  bytesInWindow: number;
  bytesOutWindow: number;
  windowMs: number;
  rssBytes: number;
  /** Milliseconds. Describes the window just ended, not all of history — see `snapshot()`. */
  loopLagP50Ms: number;
  loopLagP99Ms: number;
  loopLagMaxMs: number;
  /** Linux only; null elsewhere, and the consumer must say "unknown" rather than "fine". */
  openFds: number | null;
  maxFds: number | null;
}

/**
 * The soft `RLIMIT_NOFILE` of this process, from /proc.
 *
 * Read rather than assumed because the whole point of putting `LimitNOFILE=65535` in the systemd
 * unit is that it is easy to forget, and a relay that reports the limit it WISHES it had would
 * hide exactly the misconfiguration this exists to catch.
 */
function readMaxFds(): number | null {
  try {
    const limits = readFileSync("/proc/self/limits", "utf8");
    for (const line of limits.split("\n")) {
      if (!line.startsWith("Max open files")) continue;
      const soft = line.slice("Max open files".length).trim().split(/\s+/)[0];
      if (soft === "unlimited") return Number.POSITIVE_INFINITY;
      const n = Number.parseInt(soft, 10);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  } catch {
    return null; // not Linux, or /proc not mounted
  }
}

function readOpenFds(): number | null {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return null;
  }
}

export class RelayMetrics {
  private readonly histogram: IntervalHistogram;
  private readonly startedAt = Date.now();
  private bytesIn = 0;
  private bytesOut = 0;
  private bytesInAtLastSnapshot = 0;
  private bytesOutAtLastSnapshot = 0;
  private lastSnapshotAt = Date.now();
  private dispatched = 0;
  private readonly maxFds = readMaxFds();

  constructor() {
    // 20 ms resolution: fine enough that a p99 of "a page hung the loop" is legible, coarse
    // enough that the sampler is not itself a source of load.
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
  }

  countBytes(direction: "in" | "out", bytes: number): void {
    if (direction === "in") this.bytesIn += bytes;
    else this.bytesOut += bytes;
  }

  countDispatch(): void {
    this.dispatched += 1;
  }

  /**
   * Read the counters, and optionally close the window.
   *
   * The reset is the decision worth stating: an all-time p99 never recovers. One bad minute during
   * a deploy would sit in the number for the rest of the process's life, which trains whoever
   * reads it to ignore it. So each window describes the time since the last one, and the signal
   * goes back to normal when the box does.
   *
   * Which is exactly why `reset` is a PARAMETER and not the behaviour. There are two consumers —
   * the scheduled report to the caller, and an operator or `doctor` curling /v1/health — and if both
   * closed the window they would steal each other's: a curl during the 30-second gap would take
   * the interval the next report was about to describe, and that report would go out near-empty.
   * The periodic reporter is the single writer; every other reader looks without touching.
   */
  snapshot(browsers: number, commandsInFlight: number, reset = false): MetricsSnapshot {
    const now = Date.now();
    const windowMs = Math.max(1, now - this.lastSnapshotAt);
    const snap: MetricsSnapshot = {
      uptimeSec: Math.round((now - this.startedAt) / 1000),
      browsers,
      commandsInFlight,
      commandsDispatched: this.dispatched,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      bytesInWindow: this.bytesIn - this.bytesInAtLastSnapshot,
      bytesOutWindow: this.bytesOut - this.bytesOutAtLastSnapshot,
      windowMs,
      rssBytes: process.memoryUsage.rss(),
      loopLagP50Ms: this.histogram.percentile(50) / 1e6,
      loopLagP99Ms: this.histogram.percentile(99) / 1e6,
      loopLagMaxMs: this.histogram.max / 1e6,
      openFds: readOpenFds(),
      maxFds: this.maxFds === Number.POSITIVE_INFINITY ? null : this.maxFds,
    };
    if (reset) {
      this.histogram.reset();
      this.bytesInAtLastSnapshot = this.bytesIn;
      this.bytesOutAtLastSnapshot = this.bytesOut;
      this.lastSnapshotAt = now;
    }
    return snap;
  }
}

/** Fraction of the fd limit in use, or null where the limit is unknown (non-Linux). */
export function fdPressure(snap: MetricsSnapshot): number | null {
  if (snap.openFds === null || snap.maxFds === null || snap.maxFds <= 0) return null;
  return snap.openFds / snap.maxFds;
}
