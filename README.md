# Kilogent Browser

Lend your own Chrome to a **Kilogent** workspace, so agents can use the sites you are already
signed in to. They never see a password, and they never see a tab you opened.

The only thing you install is a Chrome extension. It dials *out*, so there is nothing to open on
your machine — no inbound port, no tunnel, no `--remote-debugging` flag.

<p align="center">
  <img src="docs/infographic.svg" alt="An agent drives your real local Chrome through an outbound-only MV3 extension" width="100%">
</p>

## This is a fork, and that is on purpose

Upstream is **[navidshad/remote-browser-mcp](https://github.com/navidshad/remote-browser-mcp)** —
the open project: the extension core, the relay, and the MCP server. This repository is the
**Kilogent-branded build** of it.

See [BRIDGE-SETUP.md](BRIDGE-SETUP.md) to put the agent on a different machine. [PRD.md](PRD.md) is kept as a historical record of the original design and no longer describes this code.

Everything Kilogent-specific lives in **one directory**, `packages/extension/src/providers/kilogent/`:

| File | What it does |
|---|---|
| `index.js` | the transport itself — what upstream's registry calls |
| `popup.js` | the panel — sign-in, workspaces, blocklist |
| `auth.js` | signing in, and keeping the session alive |
| `connection.js` | the socket to Kilogent's relay |
| `api.js` | the browser's own row, written under rules |
| `blocklist.js` | the second of the two blocklist levels |
| `config.js` | the one URL compiled in, and the storage keys |

**The rule that keeps this fork alive: never edit the core.** `executor.js`, `page-scripts.js`
and `connection.js` come from upstream untouched — as do `sw.js`, `providers/registry.js` and
`providers/bridge/` — so `git merge upstream/main` stays clean. A fix
that belongs to everybody goes upstream as a pull request and comes back down; only branding and
the Kilogent transport are ours.

```bash
git remote add upstream https://github.com/navidshad/remote-browser-mcp.git
git fetch upstream && git merge upstream/main
```

**Neither `sw.js` nor `popup.js` conflicts any more.** Both used to, on every merge, because the
transport and the sign-in UI were written into them — 390 lines where upstream had 69, and 391
where upstream had 177. Upstream grew a seam on both sides, ours moved into the directory above,
and the worker and the popup shell are now byte-identical on both sides.

Our whole divergence in code is that one directory, plus one import and one entry in each of
`providers/index.js` and `providers/panels.js`.

⚠️ `popup.html` is the small remainder. Its body is upstream's structure — same ids, same mount
point — so a structural change merges; what is ours is the heading and the stylesheet, which is
what a brand IS. And `manifest.json`, for the same reason.

📖 **[MAINTAINING.md](MAINTAINING.md)** is the guide for both jobs: the full update loop (including
which files conflict and how to resolve them), and the complete inventory of what a rebrand touches
— written from the real Lumi → Kilogent rename, so the three traps in it are ones that actually
happened rather than ones that might.

## Running it against your own server instead

The self-hosted path is untouched and needs no Kilogent account: point the extension at a bridge
you run yourself, with a URL and a shared token. See `packages/bridge-server` below, and the
Advanced section of the popup.

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
   │  AI Agent  ──MCP──▶  bridge-server                        │        │  MV3 extension  (agent profile)        │
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
| [`packages/bridge-server`](packages/bridge-server) | VM-side bridge. MCP browser tools ⇄ WebSocket to the extension, with token auth, `/health`, and per-session tab tracking. Exposes `browser_*`, `check_local_status`, and `bridge_ping`. **This is the self-host path**, and the only server in this repo — if you are running this for yourself, this is the one you want. A hosted service that wants its own transport adds one under `packages/extension/src/providers/`; see "Adding your own transport" below. Kilogent mode does not use it — that path goes to the relay below. |
| [`packages/extension`](packages/extension) | The MV3 Chrome extension. Popup for Agent URL + token, a service worker holding one outbound WS per profile (heartbeat + `chrome.alarms` keepalive + reconnect backoff), and a `chrome.debugger` executor. |
| [`packages/relay`](packages/relay) | **Side 2 of the hosted path.** One process holding one WebSocket per connected browser, so a product can address a Chrome on somebody's laptop. Presence and dispatch only — it is not an authorization boundary, and who a browser is comes from a pluggable auth provider (`ticket` or `token`). Published to npm as `remote-browser-relay`; `npm i -g remote-browser-relay` for the release, `@dev` for the pre-release. |
| [`packages/agent`](packages/agent) | A standalone terminal agent — a stand-in for the VM's real client. Connects to the bridge and runs a tool-use loop. LLM is pluggable ([`src/llm`](packages/agent/src/llm)) — **Gemini** by default, Anthropic optional — with a no-API-key `smoke` test (`npm run smoke --workspace=packages/agent`, against a running bridge). |

## Browser tools

All exposed on the one bridge MCP endpoint, mirroring Playwright MCP names:

`browser_navigate` · `browser_snapshot` · `browser_click` · `browser_type` · `browser_press_key` · `browser_take_screenshot` · `browser_wait_for` · `browser_tab_list` · `browser_tab_new` · `browser_tab_select` · `browser_tab_close` · `check_local_status` · `bridge_ping`

`browser_snapshot` returns an accessibility tree whose interactable elements are tagged with `[ref=eNN]` ids; you pass those refs to `browser_click` / `browser_type`. Refs are only valid for that tab's latest snapshot, so re-snapshot after navigation or DOM changes.

## Prerequisites

- **Node.js 22+** (`.nvmrc` pins 22.22.3)
- **Google Chrome**
- *(only if the agent runs on a different machine)* **cloudflared** or any other way to publish one
  WebSocket port — see [BRIDGE-SETUP.md](BRIDGE-SETUP.md). Not needed to try this.
- *(only for the standalone `packages/agent`)* a **Gemini API key** (`GEMINI_API_KEY`), or set `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`

## Quick start

**Start on one machine.** The agent and the browser can be on the same box, and everything below
works with no VM, no tunnel and no DNS. Put it on a VM once you have watched it drive your Chrome —
that is [BRIDGE-SETUP.md](BRIDGE-SETUP.md), and it changes one URL.

```bash
git clone https://github.com/navidshad/remote-browser-mcp
cd remote-browser-mcp
npm install
npm run build
```

### 1 · Run the bridge

Two tokens, and they must differ — the bridge refuses to start otherwise. They authenticate two
different parties: the extension to the WebSocket face, the agent to the MCP face.

```bash
export BRIDGE_ACCESS_TOKEN=$(openssl rand -hex 32)
export BRIDGE_MCP_TOKEN=$(openssl rand -hex 32)
node packages/bridge-server/dist/index.js
# MCP face → http://127.0.0.1:3000/mcp   (loopback)
# WS  face → ws://0.0.0.0:3002           (the extension dials in here)
```

### 2 · Load the extension, in one dedicated profile

1. Create a **dedicated Chrome profile** for the agent, ideally an account-less local profile so Chrome sync can't copy the extension into or out of it.
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → select [`packages/extension/`](packages/extension). Install it in **only** this profile, and turn **off** Extensions sync — that isolation is what keeps the agent off your other profiles.
3. Open the popup → **+ Add profile**. **Agent URL** is `ws://localhost:3002` on one machine (`wss://…` once it is behind a tunnel); **Access Token** is your `BRIDGE_ACCESS_TOKEN`. Press **Save**. The status line should read *Connected*.
4. Keep a window of that profile open whenever the agent may browse — **background is fine, focus is not required**. The first command attaches `chrome.debugger` and shows Chrome's "…started debugging this browser" bar; leave it in place.

### 3 · Point an agent at it

```bash
claude mcp add --transport http browser http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $BRIDGE_MCP_TOKEN"
claude mcp list      # browser → ✓ Connected
```

Then ask it to open a page. You should watch it happen in your own window.

### Verify

Two useful checks, and they answer different questions.

```bash
npm run test:mock    # the whole path — real bridge, real Executor, real MCP clients, mocked Chrome
```

That needs nothing running and no tokens: it spawns its own bridge and proves the server half works
on this machine. If it passes and your popup still will not connect, the problem is the extension,
the profile or the token — not the build.

```bash
curl -s localhost:3000/health          # → {"status":"ok",…} — liveness, no credential needed
curl -s localhost:3000/status -H "Authorization: Bearer $BRIDGE_MCP_TOKEN"   # → "extensionConnected":true
BRIDGE_MCP_TOKEN=$BRIDGE_MCP_TOKEN node packages/bridge-server/dist/test-client.js   # bridge_ping → "pong"
```

Those ask the bridge you are actually running whether your Chrome has arrived.

`/health` is deliberately thin. It used to report whether a browser was attached, how many tabs it
held and which sessions were live — a description of a specific person's Chrome, served to anyone
who could reach the port. That moved to `/status`, behind the token; `/health` stays anonymous
because a tunnel health check has no credential.

## Releases

**One release per merge to `main`, covering every package.** A release here is a snapshot of the
repo: it always states where *all* packages stand, so you can tell which extension goes with which
relay. The extension zip is attached every time, even when the change was elsewhere — the latest
release must always be somewhere you can download a working extension from.

What is skipped is the *publishing*, not the release: `scripts/resolve-versions.mjs` path-filters
each package independently, so a relay-only change does not republish an identical extension. If
nothing changed anywhere, no release is cut.

| Package | Where it goes | How to get it |
|---|---|---|
| Chrome extension | attached to the GitHub Release | download, unzip, load unpacked |
| `remote-browser-relay` | npm | `npm i -g remote-browser-relay` |

`dev` publishes the relay as a prerelease on npm's `dev` tag (`npm i -g remote-browser-relay@dev`)
and cuts **no** GitHub Release — a pre-release is for whoever asked for it by name.

```bash
npm test              # everything CI gates on — one command, same result
npm run versions      # what the next release would be, and why
```

**One workflow run per merge.** CI runs on pull requests and gates the merge; Release runs on a push
to `main` and decides what ships. They used to both run on main, running the same suite twice
against the same commit.

`npm test` runs exactly what CI gates on, and `npm run test:ci-parity` proves it by reading both
files — so a step added to `ci.yml` and not to `npm test` fails immediately, rather than the next
time somebody trusts a green laptop.

The workflow is **four jobs, not four files**, and that is deliberate. A release has to list where
*all* packages stand, so something must see every outcome at once — across separate workflow files
that means `workflow_run` chaining, which reintroduces "which commit is this about" and is where
release pipelines quietly ship the wrong thing. Jobs give the same separation with `needs` doing
the coordination:

```
resolve  ──┬──▶ relay      (npm, only if packages/relay changed)
           ├──▶ extension  (stamp + zip, always)
           └──────────────▶ publish  (one GitHub Release, from both outcomes)
```

**A failure is scoped to its package.** A relay publish that fails does not stop the extension
being built and released — the release says so instead, in the table. Anything other than an
outright success is reported as not published, because a release naming a version npm does not
have is worse than a red build.

### Versions are derived, never typed

From conventional-commit subjects: `feat` is a minor, a `!` or a `BREAKING CHANGE:` footer is a
major, everything else is a patch. Two rules are load-bearing:

- **The path filter decides *whether* to release; the type only decides *how big*.** Any commit
  touching a package's own paths releases it. An unrecognised type — `chore`, `ci`, `refactor`, an
  unparseable subject — falls through to a PATCH rather than to "no release". The conventional way
  round, where only `feat`/`fix` release, means a `refactor(relay):` that changes the shipped bundle
  publishes nothing and reports success.
- **While the major is 0, a breaking change bumps the MINOR** rather than jumping to 1.0.0.
  Reaching 1.0.0 should be somebody's decision.

**Two packages, two boundaries**, and the difference is not an inconsistency. The relay's is npm's
own `gitHead` for the published version — it cannot drift from what was actually published, which a
tag can. The extension is published to no registry, so an `extension-v*` git tag *is* its record,
pushed only after the release succeeded.

## Development

```bash
npm run test:mock       # bridge round-trip against a fake-extension WS client
npm run test:profiles   # multi-profile / multi-session harness
npm run build --workspaces
```

Each package also has `dev` (tsx watch), `start`, and `typecheck` scripts.

## Security notes

- **Two tokens, and they must differ.** `BRIDGE_ACCESS_TOKEN` authenticates the extension dialling in; `BRIDGE_MCP_TOKEN` authenticates the agent asking for work. The bridge refuses to start if you set them to the same value — one is typed into a popup on a laptop, the other pasted into an agent config, so they leak through different accidents, and sharing one would mean a leaked agent token also lets the holder impersonate the extension and take over the browser.
- **The WS face authenticates in-band**, as the first frame — a browser WebSocket cannot send `CF-Access-*` headers, so the WS hostname must have no Cloudflare Access policy in front of it. Every frame after that handshake is schema-validated and size-bounded (`protocol.ts`); the socket itself caps one frame at 12 MB.
- **The MCP face requires a bearer token** and binds to loopback by default. It used to have no authentication at all, on the reasoning that loopback was the boundary — which holds until one tunnel ingress rule exists, and was never a boundary between *users* on a shared box. Set `BRIDGE_BIND_HOST` if you genuinely mean to expose it; the token is then the only thing in front of a fully logged-in Chrome.
- **Sessions are mandatory.** Every call is routed to the tab group its MCP session owns, so a request that names no session is refused rather than being run against a shared "default".
- **The extension is the trust boundary.** It can drive any tab in its profile via `chrome.debugger`; keep it in a dedicated profile with only the accounts the agent needs.
- **Keepalive is the known risk.** MV3 evicts idle service workers; the WS heartbeat keeps it resident and a 1-minute `chrome.alarms` revives it, re-attaching `chrome.debugger` lazily on the next command.
