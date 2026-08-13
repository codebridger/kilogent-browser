#!/usr/bin/env node
// Direct live test of the LLM provider tool-use loop (bypasses readline).
// Connects to the bridge, creates a session, and
// runs one real task end-to-end. Prints the final answer.
import { selectProvider } from "./llm/index.js";
import { McpBridge } from "./mcp.js";

const BRIDGE_MCP_URL = process.env.BRIDGE_MCP_URL ?? "http://localhost:3000/mcp";
const TASK =
  process.env.TASK ??
  "Open a new tab, navigate to https://example.com, and tell me the exact page title.";

async function main() {
  const provider = selectProvider(process.env.LLM_PROVIDER || undefined);
  const model = process.env.MODEL || provider.defaultModel;
  console.log(`Provider=${provider.name} Model=${model}`);
  if (!provider.isConfigured()) {
    console.error(provider.missingKeyMessage());
    process.exit(1);
  }

  const bridge = new McpBridge(BRIDGE_MCP_URL);
  await bridge.connect();
  await bridge.listTools();
  console.log("Connected to the bridge.");

  const session = provider.createSession({
    systemPrompt:
      "You are a browser automation agent with access to a real Chrome browser. " +
      "Before browser tools, call check_local_status. Open tabs with browser_tab_new (returns a handle like 't2') and pass that handle as the `tab` arg to other tools; batch calls for different tabs in one turn to run them in parallel. Be concise.",
    model,
    listTools: () => bridge.listTools(),
    callTool: (name, args) => bridge.callTool(name, args),
  });

  console.log(`\nTask: ${TASK}\n--- tool calls ---`);
  const answer = await session.send(TASK);
  console.log(`\n--- final answer ---\n${answer || "(empty)"}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
