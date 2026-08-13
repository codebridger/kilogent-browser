// MCP wiring for the REPL and the test runners: one client against the bridge, the tool list in
// provider-neutral form, and reconnect-and-retry when a Streamable HTTP session dies.
//
// THIS USED TO BE TWO CLIENTS. The pre-bridge architecture really did have two servers — a local
// presence daemon and the official Playwright MCP attached to Chrome over CDP — so this class held
// one connection to each, tracked which server every tool name came from, and routed accordingly.
// The bridge replaced both, and the duality survived as pure ceremony: two clients dialling the
// same URL, a `sources` map answering a question with one possible answer, and a dedupe pass whose
// own comment explained that `check_local_status` appeared twice "when DAEMON_URL and the browser
// URL point at the same bridge endpoint" — which was every current setup.
//
// One endpoint, one client. `check_local_status` is served by the bridge alongside the browser
// tools, so nothing is lost.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mcpAuth } from "./auth.js";
import type { McpToolDef } from "./llm/index.js";

type Part = { type: string; text?: string };
const getContent = (r: unknown): Part[] => (r as { content?: Part[] }).content ?? [];
const firstText = (r: unknown): string => getContent(r).find((p) => p.type === "text")?.text ?? "";

/** True for errors meaning the Streamable HTTP session is gone and a fresh connect is needed. */
function isSessionError(err: unknown): boolean {
  return /Session not found|Streamable HTTP error|not connected|Connection closed|fetch failed|ECONNREFUSED/i.test(
    String(err)
  );
}

export interface ChromeStatus {
  online: boolean;
  chrome_running: boolean;
  chrome_debug_accessible: boolean;
  message: string;
}

export class McpBridge {
  private client: Client | null = null;
  private toolNames = new Set<string>();
  private notified = false;

  /** Called once, just before the first browser tool call. */
  onFirstBrowserCall?: () => void;

  constructor(private readonly mcpUrl: string) {}

  private async newClient(): Promise<Client> {
    const c = new Client({ name: "remote-browser-agent", version: "0.1.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(this.mcpUrl), mcpAuth()));
    return c;
  }

  async connect(): Promise<void> {
    this.client = await this.newClient();
  }

  get connected(): boolean {
    return this.client !== null;
  }

  async checkStatus(notify = false): Promise<ChromeStatus> {
    const res = await this.client!.callTool({
      name: "check_local_status",
      arguments: { notify },
    });
    return JSON.parse(firstText(res)) as ChromeStatus;
  }

  /** Provider-neutral tool list. */
  async listTools(): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = [];
    this.toolNames.clear();
    for (const t of (await this.client!.listTools()).tools) {
      tools.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema });
      this.toolNames.add(t.name);
    }
    return tools;
  }

  toolCount(): number {
    return this.toolNames.size;
  }

  private async rawCall(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) this.client = await this.newClient();
    const res = await this.client.callTool({ name, arguments: args });
    return firstText(res);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    // One desktop notification before the first browser command, so the owner of the Chrome knows
    // something is about to move in it.
    if (name.startsWith("browser_") && !this.notified) {
      this.notified = true;
      this.onFirstBrowserCall?.();
      await this.checkStatus(true).catch(() => {});
    }

    try {
      return await this.rawCall(name, args);
    } catch (err) {
      if (!isSessionError(err)) throw err;
      // The session died (commonly after an operation timeout). A fresh one re-attaches to the
      // same Chrome, so open tabs persist.
      this.client = null;
      try {
        this.client = await this.newClient();
      } catch (e) {
        throw new Error(`Bridge not reachable after reconnect: ${e}`);
      }
      return await this.rawCall(name, args);
    }
  }
}
