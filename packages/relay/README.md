# `@lumi.ai/relay` — the hosted relay

`lumi-relay` is the server side of **Lumi mode**: one process holding one WebSocket per connected
browser, so a product can address a Chrome sitting on somebody's laptop.

It is a **different program from [`packages/bridge-server`](../bridge-server), not a flag on it**,
and both are supported:

|  | `bridge-server` (self-host) | `relay` (Lumi mode) |
|---|---|---|
| Who runs it | you, for yourself | Lumi, for its customers |
| Browsers held | one | many, keyed `${ownerUid}:${browserId}` |
| Extension authenticates with | a static token you typed into the popup | a short-lived ticket minted by Lumi Crew |
| Serves MCP | yes — the agent connects here | **no** — the browser tools are served by Crew's own MCP server |
| Decides who may drive a browser | whoever holds the token | Crew, from live documents, on every call |

If you are self-hosting, you want `bridge-server`. Nothing here is required for that path, and it
is not going away — it is also how this repo is developed and tested.

## What it is not

**It is not an authorization boundary.** The relay knows nothing about Ships, agents, permission
windows or blocklists. It answers exactly two questions: *is this browser here*, and *deliver this
to it*. Everything about whether a given agent may drive a given browser right now is decided
upstream by Crew, from live documents, on every single call — so a permission revoked five seconds
ago stops the next action, with no state to invalidate here.

**It holds no Firebase credential.** The extension signs in to Lumi and keeps its ID token to
itself; it trades that token — at Crew, which already handles Firebase credentials — for a ticket
that does one thing: open a socket. So a relay compromise is a relay compromise, not an account
compromise for everybody connected to it. See [`src/ticket.ts`](src/ticket.ts).

## The two faces, and the one port

```
                    relay.kilogent.com (Cloudflare named tunnel)
                                   │
                    ┌──────────────┴──────────────┐
       Lumi Crew ───┤  POST /v1/dispatch          │   Bearer RELAY_CONTROL_KEY
    (Cloud Fns)     │  GET  /v1/browsers          │   + Cloudflare Access (service token)
                    │  POST /v1/session/close     │
                    │  GET  /v1/health            │
                    │                             │
    a customer's ───┤  WS   /ws                   │   in-band ticket, no headers possible
      Chrome        └─────────────────────────────┘   → and therefore NO Access policy here
```

One HTTP server carries both, and the WebSocket upgrade is routed by path. Two ports would mean
two Cloudflare ingress rules, and the day somebody adds only one of them the symptom is either
browsers that connect but never receive work, or work that dispatches into nothing.

The WS route deliberately has **no** Cloudflare Access policy in front of it, because a browser
`WebSocket` cannot send the `CF-Access-*` headers Access needs. The ticket is the entire gate,
which is why every frame after it is schema-validated with bounds — see
[`src/protocol.ts`](src/protocol.ts).

## Configuration

| Variable | Default | |
|---|---|---|
| `RELAY_CONTROL_KEY` | — | **required.** Bearer token Crew sends on every control-plane call. |
| `RELAY_TICKET_KEY` | — | **required.** Key browser tickets are signed with. Must differ from the above. |
| `RELAY_PORT` | `8787` | |
| `RELAY_BIND_HOST` | `127.0.0.1` | `cloudflared` runs on the box; the tunnel is what publishes it. |
| `RELAY_MAX_BROWSERS` | `2000` | Refused past this with WS 1013, which the extension retries. |
| `RELAY_SESSION_IDLE_MS` | `1800000` | Backstop for a job that died without a teardown. |
| `RELAY_DRAIN_GRACE_MS` | `20000` | How long a restart waits for in-flight commands. |
| `RELAY_HEALTH_URL` | — | Crew's `crewBrowserRelayHealth`. Unset means "not reporting". |
| `RELAY_HEALTH_INTERVAL_MS` | `30000` | |
| `RELAY_INSTANCE_ID` | `relay` | Names this box in its health reports. |

**The two keys must differ, and the process refuses to start if they do not.** One is sent in a
header on every dispatch — over the tunnel, through Cloudflare, into anything that logs a request.
The other is a *signing* key: whoever holds it can mint a ticket and connect as somebody else's
browser. A signing key must never be the thing you put in a header hundreds of times a minute.

```bash
export RELAY_CONTROL_KEY=$(openssl rand -hex 32)
export RELAY_TICKET_KEY=$(openssl rand -hex 32)
node dist/index.js
```

## What health actually measures

Four signals, reported every 30 s and readable at `GET /v1/health`. **Not CPU** — a burstable
`$5` instance is idle by design, and credit throttling shows up as latency long before its CPU
percentage looks wrong.

- **file descriptors** — one browser is one socket is one fd, and the default soft limit of ~1024
  caps you near 950 browsers and then fails inside `accept` as `EMFILE`, which reads like a network
  fault. The limit is *read from `/proc/self/limits`*, not assumed, so a missing
  `LimitNOFILE=65535` in the unit file is visible rather than silently in effect.
- **event-loop lag** (p50/p99/max) — the direct measure of "this process is late". The histogram is
  reset per reporting window, because an all-time p99 never recovers and therefore stops being read.
- **bandwidth** — the thing on a cheap box that produces a surprise *bill* rather than an outage.
  Screenshots are large.
- **RSS**.

`openFds`/`maxFds` are Linux-only and come back `null` elsewhere. A consumer must render that as
*unknown*, never as *fine*.

## Restarting without breaking a click

`SIGTERM` **drains first**: in-flight commands are given `RELAY_DRAIN_GRACE_MS` to finish, because
each one is a click somebody's agent already committed to. Sockets are then closed with WS **1012
"Service Restart"**, which the extension's existing backoff already treats as temporary — so a
relay upgrade costs a browser a few seconds of reconnect and needs no extension change at all.

## Dispatch outcomes

The response **body**'s `outcome` is the contract; the HTTP status is a courtesy for anything in
between that only reads numbers.

| `outcome` | status | means |
|---|---|---|
| `ok` | 200 | the browser answered. `result.isError` may still be true — the page did not cooperate, which is a sentence for the agent, not a transport failure. |
| `browser_not_here` | 409 | this relay does not hold that socket. **Retry** — during a migration between boxes a dispatch can land on the wrong connector. |
| `disconnected` | 409 | it was here and went away mid-command. |
| `busy` | 429 | 64 commands already in flight to that one browser. |
| `timeout` | 504 | the relay's own deadline, strictly inside Crew's. |
| `send_failed` | 502 | the socket rejected the write. |

## Tests

```bash
npm test --workspace=packages/relay
```

Mostly integration, on purpose: a real relay on an ephemeral port, real WebSockets, real HTTP.
Everything that can actually go wrong here lives in how the pieces meet — a reconnect superseding
a socket with a command in flight, an upgrade on the wrong path, a drain with work outstanding —
and none of it is reachable by exercising a class alone.
