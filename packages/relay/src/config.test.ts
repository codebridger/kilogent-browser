import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const ok = { RELAY_CONTROL_KEY: A, RELAY_TICKET_KEY: B } as NodeJS.ProcessEnv;

describe("relay config", () => {
  it("defaults to loopback, so exposing the process is a deliberate act with a name", () => {
    const c = loadConfig(ok);
    assert.equal(c.bindHost, "127.0.0.1");
    assert.equal(c.port, 8787);
  });

  it("refuses to start without the control key, and names the fix", () => {
    assert.throws(() => loadConfig({ RELAY_TICKET_KEY: B }), /RELAY_CONTROL_KEY.*openssl rand/s);
  });

  it("refuses to start without the ticket key", () => {
    assert.throws(() => loadConfig({ RELAY_CONTROL_KEY: A }), /RELAY_TICKET_KEY.*openssl rand/s);
  });

  it("refuses one secret doing both jobs", () => {
    // The control key is sent in a header on every dispatch; the ticket key SIGNS the proof a
    // browser is whose it says. Sharing one makes the credential with the widest exposure also
    // the one that can impersonate any connected browser.
    assert.throws(
      () => loadConfig({ RELAY_CONTROL_KEY: A, RELAY_TICKET_KEY: A }),
      /same value/
    );
  });

  it("refuses a key short enough to guess", () => {
    assert.throws(
      () => loadConfig({ RELAY_CONTROL_KEY: "short", RELAY_TICKET_KEY: B }),
      /at least 32 characters/
    );
  });

  it("refuses a plaintext health URL, because the report carries the control key", () => {
    assert.throws(
      () => loadConfig({ ...ok, RELAY_HEALTH_URL: "http://crew.example/health" }),
      /must be https/
    );
    // A local emulator is the one exception, and it is pinned to loopback rather than to "http".
    assert.equal(
      loadConfig({ ...ok, RELAY_HEALTH_URL: "http://127.0.0.1:5001/x" }).healthUrl,
      "http://127.0.0.1:5001/x"
    );
  });

  it("treats an unset health URL as 'not reporting', not as an error", () => {
    assert.equal(loadConfig(ok).healthUrl, null);
    assert.equal(loadConfig({ ...ok, RELAY_HEALTH_URL: "  " }).healthUrl, null);
  });

  it("refuses a non-numeric override rather than silently using the default", () => {
    assert.throws(() => loadConfig({ ...ok, RELAY_PORT: "eight-thousand" }), /RELAY_PORT/);
    assert.throws(() => loadConfig({ ...ok, RELAY_MAX_BROWSERS: "-1" }), /RELAY_MAX_BROWSERS/);
  });
});
