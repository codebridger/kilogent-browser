# Remote Browser MCP

Give an AI agent running on a remote VM control of a **real Chrome on your own machine** through the Model Context Protocol — reusing your real logins, cookies, extensions, and home IP, while you watch and take over at any time.

<p align="center">
  <img src="docs/infographic.svg" alt="Remote Browser MCP — an AI agent on a cloud VM drives your real local Chrome through an outbound-only MV3 extension" width="100%">
</p>

Cloud browsers get blocked, fingerprinted, and logged out. Your own Chrome is already trusted everywhere — Remote Browser MCP simply lets your agent use it. The **only thing you install locally is a Chrome extension**. It dials *out* to the agent, so there are no inbound ports, no local tunnel, and no `--remote-debugging` flags on your machine. Set it up once, and any MCP-speaking agent can browse as *you* — while you literally watch it work in your own browser window.

Perfect for: personal automation agents (LinkedIn outreach, dashboards behind SSO, admin panels), research agents that need sites in your logged-in state, and any workflow where a headless datacenter browser just gets captcha-walled.

See [PRD.md](PRD.md) for the product rationale and [BRIDGE-SETUP.md](BRIDGE-SETUP.md) for the full deployment runbook.

## Features

- 🔐 **Browse as yourself** — the agent works inside your genuine Chrome profile: existing logins, cookies, sessions, extensions, and your home IP. No credential sharing, no re-authentication, no datacenter/bot fingerprint.
- 📡 **Outbound-only, token-authenticated** — the extension dials out over `wss://` and authenticates with a shared token. Zero inbound ports, zero local tunnels, zero debug flags on your machine.
- 🔌 **Standard MCP, Playwright-compatible tools** — one Streamable-HTTP MCP endpoint with tool names mirroring the official Playwright MCP (`browser_navigate`, `browser_snapshot`, `browser_click`, …). Works out of the box with Claude Code or any MCP client; agents written against Playwright MCP port over almost unchanged.
- 👀 **Live activity overlay** — a colored ring + status badge appears on the page whenever the agent acts, so you always know what it's doing. It self-clears the moment the agent goes idle.
- ✋ **Take over anytime** — it's your real browser window; just grab the mouse. An optional per-profile input-lock prevents you from *accidentally* fighting the agent mid-task, and always self-releases.
- 🤖 **Multi-agent, multi-profile** — run several Chrome profiles, each dialed into its own bridge. Every MCP session gets its own Chrome tab group, so parallel agents keep their work visually separate and never touch each other's tabs.
- 🧱 **Profile-level isolation** — a Chrome extension can only act within its own profile. Install it in one dedicated profile and the agent physically cannot reach your personal browsing.
- 🧪 **Snapshot-driven control** — the agent reads pages as accessibility trees with stable `[ref=eNN]` element ids, then clicks/types by ref. Faster and more reliable than pixel-hunting screenshots (screenshots are there too when needed).
- 🩺 **Self-healing & observable** — WebSocket heartbeat + `chrome.alarms` keepalive survive MV3 service-worker eviction, reconnect with backoff, and re-attach the debugger lazily. `/health`, `bridge_ping`, and `check_local_status` tell the agent whether a human/browser is actually there. Idle sessions are reaped automatically.
- 🪶 **Tiny footprint** — no Playwright install, no Node process, no daemon on your machine. One unpacked MV3 extension; everything else lives on the VM.

## How it works

There are two halves that meet over an authenticated WebSocket:

- **On the VM** — [`packages/bridge-server`](packages/bridge-server) exposes browser control to the agent as MCP and relays each command to the browser. It has two faces:
  - an **MCP** face on `localhost:3000/mcp` — the VM's Claude Code (or [`packages/agent`](packages/agent)) connects here and calls `browser_*` tools. Requires `Authorization: Bearer $BRIDGE_MCP_TOKEN`;
  - a **WebSocket** face on `localhost:3002` — the extension dials in and authenticates with a shared token. `cloudflared` running *on the VM* publishes this face at a `wss://` URL.
- **On your machine** — the [`packages/extension`](packages/extension) MV3 extension runs in a dedicated Chrome profile, dials out to that `wss://` URL, and drives a real tab with `chrome.debugger` (CDP).

```
   ┌──────────────────────── CLOUD VM ────────────────────────┐        ┌───────────── YOUR MACHINE ─────────────┐
   │  AI Agent  ──MCP──▶  bridge-server                        │        │  MV3 extension  (Aso Dara profile)     │
   │  (Claude Code /       ├─ MCP face  localhost:3000/mcp     │        │    │                                    │
   │   packages/agent)     └─ WS  face  localhost:3002 ◀───────┼── wss ─┼────┘  dials OUT, token-authenticated   │
   │                          published by cloudflared         │        │    chrome.debugger / CDP  ──▶  a tab   │
   └───────────────────────────────────────────────────────────┘        └────────────────────────────────────────┘
                                        ▲                                          nothing inbound on your machine
                                        └──────── agent never touches localhost; always over the network ─────────
```

Browser tool names **mirror the official [Playwright MCP](https://github.com/microsoft/playwright-mcp)**, so an agent (or contract) written against Playwright MCP works with almost no changes.

## Why not just…

| Alternative | What goes wrong |
|---|---|
| **A headless browser on the VM** | Fresh profile with no logins, a datacenter IP, and a bot fingerprint — captchas, blocks, and 2FA prompts everywhere. |
| **Chrome with `--remote-debugging-port`** | Chrome 136+ blocks it on your default profile, so you lose your real logins anyway — and you're running your browser with an open debug port. |
| **Tunneling into your machine** | Inbound access to your laptop (tunnel daemons, port forwarding, access policies) just to reach a browser. Here the browser dials *out* instead — there is nothing to reach. |
| **Sharing credentials with the agent** | Passwords and 2FA secrets in an agent's context. Here the agent gets a browser that is *already* signed in and never sees a credential. |

## Packages

| Path | What it is |
|---|---|
| [`packages/bridge-server`](packages/bridge-server) | VM-side bridge. MCP browser tools ⇄ WebSocket to the extension, with token auth, `/health`, and per-session tab tracking. Exposes `browser_*`, `check_local_status`, and `bridge_ping`. **This is the self-host path**, and the only server in this repo — if you are running this for yourself, this is the one you want. A hosted service that wants its own transport adds one under `packages/extension/src/providers/`; see "Adding your own transport" above. |
| [`packages/extension`](packages/extension) | The MV3 Chrome extension. Popup for Agent URL + token, a service worker holding one outbound WS per profile (heartbeat + `chrome.alarms` keepalive + reconnect backoff), and a `chrome.debugger` executor. |
| [`packages/relay`](packages/relay) | **Side 2 of the hosted path.** One process holding one WebSocket per connected browser, so a product can address a Chrome on somebody's laptop. Presence and dispatch only — it is not an authorization boundary, and who a browser is comes from a pluggable auth provider (`ticket` or `token`). Published to npm as `@lumi.ai/relay`; `npm i -g @lumi.ai/relay` for the release, `@dev` for the pre-release. |
| [`packages/agent`](packages/agent) | A standalone terminal agent — a stand-in for the VM's real client. Connects to the bridge and runs a tool-use loop. LLM is pluggable ([`src/llm`](packages/agent/src/llm)) — **Gemini** by default, Anthropic optional — with a no-API-key `smoke` test. |
| [`packages/daemon`](packages/daemon) | Legacy local MCP sidecar (presence + session notifications) from the pre-bridge architecture. Kept for reference; superseded by the bridge. |

## Adding your own transport

The extension ships one way of reaching an agent — the self-hosted `bridge` above. A product that
wants its own (its own sign-in, its own server, its own rules about who may drive a browser) adds
a **transport** rather than editing the worker.

```
packages/extension/src/
  sw.js                    Chrome's plumbing, and nothing else. Never edit this in a fork.
  executor.js              CDP. Core.
  page-scripts.js          what runs inside the page. Core.
  connection.js            one WebSocket to one bridge. Core.
  popup.js / popup.html    the popup SHELL. Never edit these in a fork either.
  providers/
    registry.js            the worker's fan-out. Core.
    panels.js              ← one line a fork adds (the popup)
    index.js               ← one line a fork adds (the worker)
    bridge/
      index.js             the self-hosted transport
      popup.js             its panel
    <yours>/               ← the directory a fork adds
```

There are TWO registration points, and they are separate on purpose: `providers/index.js` lists
TRANSPORTS for the service worker, `providers/panels.js` lists PANELS for the popup. One list would
drag the CDP driver into a window that only draws buttons, on every popup open.

A transport is a plain object with optional methods — `reconcile`, `onDetach`, `onTabRemoved`,
`status`, `onMessage`, `reconnectAll`, `teardown`. A panel has `name`, `mount(root)` and
`render(snapshot)`, and **owns its own markup**: the shell hands it an empty `<section>` and
`popup.html` stays core. `registry.js` and `panels.js` document both shapes. Two rules make it
work:

- **Return `undefined` from `onMessage` for anything that is not yours.** The first transport to
  return anything else claims the message and the rest never see it, because Chrome allows exactly
  one reply.
- **Contribute a `status()` that does not collide.** The keys are shallow-merged, and `profiles`
  already belongs to the bridge.

One transport cannot break another: every call is isolated, so a half-finished transport is a
transport that does not work rather than an extension that does not work. `npm run test:registry`
covers that, among other things.

**A fork should never need to touch `sw.js`, `popup.js`, `popup.html`, `executor.js`,
`page-scripts.js` or `connection.js`.** That is what keeps `git merge upstream/main` clean. If the seam will not stretch far enough for
what you are building, open an issue — it is young and it is meant to move.

## Browser tools

All exposed on the one bridge MCP endpoint, mirroring Playwright MCP names:

`browser_navigate` · `browser_snapshot` · `browser_click` · `browser_type` · `browser_select_option` · `browser_press_key` · `browser_take_screenshot` · `browser_wait_for` · `browser_tab_list` · `browser_tab_new` · `browser_tab_select` · `browser_tab_close` · `check_local_status` · `bridge_ping`

`browser_snapshot` returns an accessibility tree whose interactable elements are tagged with `[ref=eNN]` ids; you pass those refs to `browser_click` / `browser_type`. Refs are only valid for that tab's latest snapshot, so re-snapshot after navigation or DOM changes.

Two arguments keep a big page from costing a whole snapshot: `find` returns only the lines containing some text, and `ref` returns only one element's line. Both filter what comes **back**, not what is reachable — every element still gets a ref, so one you were not shown still works. A miss says how big the page was, so an empty answer never looks like an empty page.

`browser_select_option` is for a real `<select>` only. It sets the property and fires `input` + `change`, because the list a `<select>` opens is drawn by the operating system and no synthetic click can reach it. A dropdown a site built out of `<div>`s is not a `<select>` — the tool says so, and that one is clicked like anything else.

## Prerequisites

- **Node.js 22+**
- **Google Chrome**
- **cloudflared** on the VM (`brew install cloudflared` / apt) — publishes the WebSocket face
- A shared token: `openssl rand -hex 32` — the same value goes on the VM and in the extension popup
- *(only for the standalone `packages/agent`)* a **Gemini API key** (`GEMINI_API_KEY`), or set `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`

## Quick start

Three steps: run the bridge on the VM, load the extension in Chrome, verify. About ten minutes end to end.

```bash
npm install
npm run build
```

### 1 · VM — run the bridge

```bash
BRIDGE_ACCESS_TOKEN=<token> BRIDGE_MCP_TOKEN=<mcp-token> MCP_PORT=3000 WS_PORT=3002 \
  node packages/bridge-server/dist/index.js
# or under pm2:
BRIDGE_ACCESS_TOKEN=<token> BRIDGE_MCP_TOKEN=<mcp-token> pm2 start packages/bridge-server/dist/index.js --name rbm-bridge
```

Publish the WS face with `cloudflared` and point the VM's agent at the MCP face
(`http://localhost:3000/mcp`). Full ingress config and DNS notes are in
[BRIDGE-SETUP.md](BRIDGE-SETUP.md).

### 2 · Machine — load the extension (one dedicated profile)

1. Create a **dedicated Chrome profile** for the agent (e.g. "Aso Dara"), ideally an account-less local profile so Chrome sync can't copy the extension into or out of it.
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → select [`packages/extension/`](packages/extension). Install it in **only** this profile, and turn **off** Extensions sync — that isolation is what keeps the agent off your other profiles.
3. Open the popup and set **Agent URL** (`wss://…/rbm-ws`) + **Access Token** (the token from step 1) → **Save & Connect**. Status should read *Connected to agent*.
4. Keep a window of that profile open whenever the agent may browse — **background is fine, focus is not required**. The first command attaches `chrome.debugger` and shows Chrome's "…started debugging this browser" bar; leave it in place.

### 3 · Verify end-to-end

```bash
# on the VM
curl -s localhost:3000/health          # → {"status":"ok",…} — liveness, no credential needed
curl -s localhost:3000/status -H "Authorization: Bearer $BRIDGE_MCP_TOKEN"   # → "extensionConnected":true
BRIDGE_MCP_TOKEN=$BRIDGE_MCP_TOKEN node packages/bridge-server/dist/test-client.js   # bridge_ping → "pong"
```

`/health` is deliberately thin. It used to report whether a browser was attached, how many tabs it
held and which sessions were live — a description of a specific person's Chrome, served to anyone
who could reach the port. That moved to `/status`, behind the token; `/health` stays anonymous
because a tunnel health check has no credential.

Or drive the whole path with the standalone agent's no-API-key check:

```bash
npm run smoke --workspace=packages/agent
```

## Releases

Two things ship, and they ship differently.

**The extension** has no build step — the directory is what Chrome loads. CI zips it on every
commit and attaches it as an artifact; that zip is what you sideload or upload to the Web Store.

**The relay** publishes to npm on two channels:

| Branch | Version | dist-tag | Install |
|---|---|---|---|
| `dev` | `<next>-dev.<run>` | `dev` | `npm i -g @lumi.ai/relay@dev` |
| `main` | `<next>` | `latest` | `npm i -g @lumi.ai/relay` |

The version is **derived, never typed**. `scripts/resolve-relay-version.mjs` walks the commits
since the last publish and picks the bump from conventional-commit subjects: `feat` is a minor,
a `!` or a `BREAKING CHANGE:` footer is a major, everything else is a patch.

Two rules in that script are worth knowing before you change it:

- **The path filter decides *whether* to release; the type only decides *how big*.** Any commit
  touching `packages/relay/**` releases. An unrecognised type — `chore`, `ci`, `refactor`, an
  unparseable subject — falls through to a PATCH rather than to "no release". The conventional way
  round, where only `feat`/`fix` release, means a `refactor(relay):` that changes the shipped
  bundle publishes nothing and says it succeeded.
- **While the major is 0, a breaking change bumps the MINOR** rather than jumping to 1.0.0.
  Reaching 1.0.0 should be somebody's decision.

The boundary is npm's own `gitHead` for the published version, so there is nothing to tag and
nothing to push. If it cannot be resolved, the job **fails closed** rather than guessing.

## Development

```bash
npm run test:mock        # bridge round-trip against a fake-extension WS client
npm run test:profiles    # multi-profile / multi-session harness
npm run test:registry    # the extension's transport fan-out, plus the real bridge transport
npm run test:popup       # the popup shell and its panels, against a real DOM
npm run test:snapshot    # browser_snapshot's find/ref narrowing, against the real page script
npm run test:select      # browser_select_option, against the real page script
npm run build --workspaces
```

The last three need no bridge and no browser. `test:snapshot` and `test:select` import the page
script's own functions and run them against a stub DOM, so a change to matching, or to the events a
`<select>` fires, is caught in milliseconds. `test:registry` drives the service worker's fan-out
with fake transports and then with the real one.

What none of them can see is a real page: CDP, a real framework's own event handling, and a
dropdown a site drew itself out of `<div>`s. **Loading the extension in Chrome is part of the loop,
not an optional extra.**

Each package also has `dev` (tsx watch), `start`, and `typecheck` scripts.

## Security notes

- **Two tokens, and they must differ.** `BRIDGE_ACCESS_TOKEN` authenticates the extension dialling in; `BRIDGE_MCP_TOKEN` authenticates the agent asking for work. The bridge refuses to start if you set them to the same value — one is typed into a popup on a laptop, the other pasted into an agent config, so they leak through different accidents, and sharing one would mean a leaked agent token also lets the holder impersonate the extension and take over the browser.
- **The WS face authenticates in-band**, as the first frame — a browser WebSocket cannot send `CF-Access-*` headers, so the WS hostname must have no Cloudflare Access policy in front of it. Every frame after that handshake is schema-validated and size-bounded (`protocol.ts`); the socket itself caps one frame at 12 MB.
- **The MCP face requires a bearer token** and binds to loopback by default. It used to have no authentication at all, on the reasoning that loopback was the boundary — which holds until one tunnel ingress rule exists, and was never a boundary between *users* on a shared box. Set `BRIDGE_BIND_HOST` if you genuinely mean to expose it; the token is then the only thing in front of a fully logged-in Chrome.
- **Sessions are mandatory.** Every call is routed to the tab group its MCP session owns, so a request that names no session is refused rather than being run against a shared "default".
- **The extension is the trust boundary.** It can drive any tab in its profile via `chrome.debugger`; keep it in a dedicated profile with only the accounts the agent needs.
- **Keepalive is the known risk.** MV3 evicts idle service workers; the WS heartbeat keeps it resident and a 1-minute `chrome.alarms` revives it, re-attaching `chrome.debugger` lazily on the next command.

## License

[Apache-2.0](LICENSE). Use it, change it, sell it, fork it and ship your own build.

The one thing the licence does not give you is the **name**. Section 6 grants no rights to trade names, trademarks or product names, beyond describing where the code came from. So a fork is free to exist and free to be commercial, and must not present itself as this project. That is on purpose: it means customising is a fork, not a plugin system built to keep branding out of your hands.

This repo asks you to trust it with a logged-in browser. Reading it before you install it is the point, and a licence is what makes reading it useful.
