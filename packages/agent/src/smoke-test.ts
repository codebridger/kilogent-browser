#!/usr/bin/env node
// Connectivity smoke test — verifies the agent can reach both MCP servers and
// drive the browser, WITHOUT needing an Anthropic API key. Exercises the same
// transports the agent uses.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mcpAuth } from "./auth.js";

const BRIDGE_MCP_URL = process.env.BRIDGE_MCP_URL ?? "http://localhost:3000/mcp";
const TEST_URL = process.env.TEST_URL ?? "https://example.com";

type Part = { type: string; text?: string };
const firstText = (r: unknown): string =>
  ((r as { content?: Part[] }).content ?? []).find((p) => p.type === "text")?.text ?? "";

let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => {
  console.log(`  ✗ ${m}`);
  failures++;
};

async function main() {
  console.log("Remote Browser MCP — smoke test\n");

  // One endpoint serves both surfaces: check_local_status AND the browser_* tools. This used to be
  // two connections to two servers, and became two connections to the same URL.
  console.log("Bridge:");
  let pw: Client;
  try {
    pw = new Client({ name: "smoke-test", version: "0.1.0" });
    await pw.connect(new StreamableHTTPClientTransport(new URL(BRIDGE_MCP_URL), mcpAuth()));
    pass(`connected to ${BRIDGE_MCP_URL}`);
  } catch (err) {
    fail(`could not connect: ${err}`);
    summary();
    return;
  }

  const tools = await pw.listTools();
  tools.tools.some((t) => t.name === "check_local_status")
    ? pass("check_local_status tool present")
    : fail("check_local_status tool missing");
  tools.tools.some((t) => t.name === "browser_navigate")
    ? pass(`browser tools present (${tools.tools.length} tools)`)
    : fail("browser_navigate tool missing");

  const status = JSON.parse(
    firstText(await pw.callTool({ name: "check_local_status", arguments: {} }))
  );
  console.log(`    status: ${status.message}`);
  status.online ? pass("machine reported online") : fail("machine reported offline");

  // 3. Drive the browser
  if (status.chrome_debug_accessible) {
    console.log("\nBrowser drive:");
    const nav = firstText(
      await pw.callTool({ name: "browser_navigate", arguments: { url: TEST_URL } })
    );
    nav.includes(TEST_URL.replace(/^https?:\/\//, "").replace(/\/$/, ""))
      ? pass(`navigated to ${TEST_URL}`)
      : fail(`navigate result unexpected: ${nav.slice(0, 120)}`);
  } else {
    console.log("\nBrowser drive: skipped (Chrome debugging not accessible)");
  }

  summary();
}

function summary() {
  console.log();
  if (failures === 0) {
    console.log("✓ All checks passed.");
    process.exit(0);
  } else {
    console.log(`✗ ${failures} check(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Smoke test error:", err);
  process.exit(1);
});
