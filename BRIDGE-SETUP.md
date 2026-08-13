# Bridge setup — extension ↔ VM, over a tunnel

The full deployment path: a bridge on a VM, published over a Cloudflare tunnel, with the extension
dialling out to it from your own machine.

**You do not need any of this to try the project.** The bridge listens on `0.0.0.0:3002`, so on one
machine you can put `ws://localhost:3002` straight into the extension popup and skip every step
below. Do that first — the tunnel is what you add once it already works, not a prerequisite for
seeing it work.

Placeholders used throughout, all yours to fill in:

| Placeholder | Meaning |
|---|---|
| `<vm-user>@<vm-host>` | wherever you run the bridge |
| `<bridge-host>` | the public hostname you publish the WebSocket face on |
| `<tunnel-name>` | your Cloudflare named tunnel |

## 1. Pick two tokens

Two, not one, and they must differ — the bridge refuses to start otherwise.

```bash
openssl rand -hex 32   # BRIDGE_MCP_TOKEN  — the agent sends this to the MCP face
openssl rand -hex 32   # BRIDGE_ACCESS_TOKEN   — the extension sends this to the WebSocket face
```

Keep them out of the repo. Anything that can read them can drive a logged-in browser.

## 2. VM — run the bridge

Node 22+ (see `.nvmrc`).

```bash
npm ci && npm run build

BRIDGE_MCP_TOKEN=… BRIDGE_ACCESS_TOKEN=… node packages/bridge-server/dist/index.js
# MCP face  → localhost:3000/mcp
# WS  face  → 0.0.0.0:3002
```

Under pm2, if you want it to survive a reboot:

```bash
pm2 start packages/bridge-server/dist/index.js --name rbm-bridge --update-env && pm2 save
```

Not `pm2 start ecosystem.config.cjs` — that file predates the bridge and starts five processes of
the retired Playwright architecture, none of which is this server.

## 3. VM — publish the WebSocket face

Only the **WS face** is published. The MCP face stays on loopback: the agent runs on the same VM.

`~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-name>
credentials-file: /home/<vm-user>/.cloudflared/<tunnel-name>.json

ingress:
  - hostname: <bridge-host>
    path: ^/rbm-ws
    service: http://localhost:3002
  - service: http_status:404
```

Then `cloudflared tunnel route dns <tunnel-name> <bridge-host>` and restart the tunnel.

⚠️ **Whatever you put in front of this hostname is the only network boundary there is.** If you add
a Cloudflare Access policy, the extension cannot answer its login challenge — it is a background
service worker, not a person with a browser tab. So either leave the path unprotected and rely on
`BRIDGE_ACCESS_TOKEN`, or use an Access **service token** and add those headers to the extension's
request. Decide deliberately; do not discover it later.

Reusing an existing hostname with a path rule works and saves a DNS record. A dedicated hostname is
cleaner if you have one to spare.

## 4. VM — point the agent at the bridge

```bash
claude mcp add --transport http browser http://localhost:3000/mcp \
  --header "Authorization: Bearer $BRIDGE_MCP_TOKEN"
claude mcp list      # 'browser' → ✓ Connected
```

The bearer token is **required**. The MCP face once had no authentication at all, on the reasoning
that loopback was the boundary. It is a boundary right up until somebody adds one tunnel ingress
rule — and it is never a boundary between *users* on a shared box. If you do expose it, set
`BRIDGE_BIND_HOST` deliberately, and know that the token is then the only thing standing in front of
a fully logged-in Chrome.

## 5. Your machine — load the extension, in one profile only

1. Create a **dedicated Chrome profile** for the agent. An account-less local profile is best, so
   Chrome sync cannot copy the extension into or out of it.
2. In that profile: `chrome://extensions` → **Developer mode** → **Load unpacked** →
   select `packages/extension/`.
3. **Install it in this profile only, and turn Extensions sync off.** A Chrome extension can only
   act inside its own profile — that is the whole isolation story, and sync is the one thing that
   breaks it.
4. Open the popup and add a profile:
   - **Agent URL:** `wss://<bridge-host>/rbm-ws`
   - **Access Token:** your `BRIDGE_ACCESS_TOKEN`
   - **Save** → the status line should read *Connected to agent*.
5. Keep a window of that profile open. Background is fine; focus is not required. The first browser
   command attaches `chrome.debugger` and Chrome shows a *"…started debugging this browser"* bar —
   leave it. Clicking **Cancel** detaches until the next command.

## 6. Verify

```bash
# on the VM
curl -s localhost:3000/health                       # {"status":"ok",...} — liveness only, no token
curl -s -H "Authorization: Bearer $BRIDGE_MCP_TOKEN" localhost:3000/status
                                                    # "extensionConnected": true
node packages/bridge-server/dist/test-client.js     # bridge_ping → pong
```

`extensionConnected` lives on `/status`, behind the token — `/health` deliberately says nothing
about who is connected.

Then ask the agent to `browser_navigate` somewhere and `browser_snapshot`. You should watch it
happen in your own window.

### Multi-tab and multi-agent

Every MCP session gets its own Chrome tab group, so parallel agents keep their tabs separate and
never touch each other's. Several profiles can each dial their own bridge.

### Keepalive soak

MV3 evicts service workers, which is the make-or-break risk for a long-running session. The
WebSocket heartbeat plus a `chrome.alarms` keepalive are what survive it. If you are going to trust
this with a long task, soak it first: loop `browser_snapshot` for an hour and watch for gaps.
