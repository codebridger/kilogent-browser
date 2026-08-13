#!/usr/bin/env node
import readline from "readline";
import { selectProvider } from "./llm/index.js";
import { McpBridge } from "./mcp.js";

// ── Config from env ──────────────────────────────────────────────────────────
// One endpoint. DAEMON_URL/PLAYWRIGHT_URL named the two servers of the pre-bridge architecture;
// the bridge serves both surfaces, so there is one URL and one name for it.
const BRIDGE_MCP_URL = process.env.BRIDGE_MCP_URL ?? "http://localhost:3000/mcp";
const provider = selectProvider(process.env.LLM_PROVIDER || undefined);
// `||` not `??`: an empty MODEL="" (e.g. from an unset compose var) falls back too.
const MODEL = process.env.MODEL || provider.defaultModel;

const SYSTEM_PROMPT =
  "You are a browser automation agent with access to a real Chrome browser on the user's local machine. " +
  "Before using any browser tools, call check_local_status (with notify=true on the first call) to confirm the machine is online and Chrome is ready. " +
  "You can work on multiple pages at once: open a tab with browser_tab_new (it returns a stable handle like 't2') and pass that handle as the `tab` argument to browser_navigate/snapshot/click/type/etc. to drive that specific tab. Omitting `tab` uses the session's active tab. " +
  "To work in parallel, open several tabs and issue multiple tool calls in a SINGLE turn targeting DIFFERENT tabs — they run concurrently. Keep steps that depend on each other on the SAME tab in separate turns, since same-tab calls in one batch are not ordered. " +
  "After a page navigates or a dialog is dismissed, take a fresh browser_snapshot of that tab before clicking, since element refs from a previous snapshot are per-tab and go stale. " +
  "Be concise in your responses. Describe what you did and what you found.";

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║      Remote Browser MCP Agent        ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();
  console.log(`Bridge    : ${BRIDGE_MCP_URL}`);
  console.log(`Provider  : ${provider.name}`);
  console.log(`Model     : ${MODEL}`);
  console.log();

  if (!provider.isConfigured()) {
    console.error(`Error: ${provider.missingKeyMessage()}`);
    process.exit(1);
  }

  const bridge = new McpBridge(BRIDGE_MCP_URL);

  process.stdout.write("Connecting to the bridge... ");
  try {
    await bridge.connect();
    console.log("✓");
  } catch (err) {
    console.log(`✗\n  ${err}`);
    console.error(
      "\nCannot reach the bridge. Is it running, and is BRIDGE_MCP_TOKEN the value it was started with?"
    );
    process.exit(1);
  }

  // Initial status check
  console.log();
  try {
    const status = await bridge.checkStatus();
    console.log(`Status: ${status.message}`);
    if (!status.chrome_running) {
      console.log(
        "\n⚠  No browser is attached. Open a window of the Chrome profile that has the extension\n" +
          "   installed, and check the popup reads Connected."
      );
    }
  } catch (err) {
    console.log(`Status check failed: ${err}`);
  }

  const initialTools = await bridge.listTools();
  console.log(`\nTools available: ${initialTools.length}\n`);

  const session = provider.createSession({
    systemPrompt: SYSTEM_PROMPT,
    model: MODEL,
    listTools: () => bridge.listTools(),
    callTool: (name, args) => bridge.callTool(name, args),
  });

  // ── Chat loop ─────────────────────────────────────────────────────────────
  // A line queue (rather than `for await (const line of rl)`) so input is handled
  // deterministically whether it's an interactive TTY or piped/buffered stdin —
  // readline's async iterator can drop lines emitted before iteration begins.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  const queue: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  rl.on("line", (l) => {
    queue.push(l);
    wake?.();
    wake = null;
  });
  rl.on("close", () => {
    closed = true;
    wake?.();
    wake = null;
  });

  const nextLine = async (): Promise<string | null> => {
    while (queue.length === 0 && !closed) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    return queue.shift() ?? null;
  };

  console.log("Type a command (or /status, /tools, /quit):\n");
  rl.prompt();

  for (let line = await nextLine(); line !== null; line = await nextLine()) {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      continue;
    }

    if (input === "/quit" || input === "/exit") {
      break;
    }

    if (input === "/status") {
      console.log("\n" + JSON.stringify(await bridge.checkStatus(), null, 2) + "\n");
      rl.prompt();
      continue;
    }

    if (input === "/tools") {
      const t = await bridge.listTools();
      console.log(`\n${t.length} tools:`);
      for (const tool of t) console.log(`  • ${tool.name}`);
      console.log();
      rl.prompt();
      continue;
    }

    try {
      const text = await session.send(input);
      if (text) console.log("\n" + text);
    } catch (err) {
      console.error(`\nError: ${err}`);
    }
    rl.prompt();
  }

  rl.close();
  console.log("\nGoodbye.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
