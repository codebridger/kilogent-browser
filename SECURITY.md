# Security

## Reporting a vulnerability

Use GitHub's private reporting: **[Report a vulnerability](https://github.com/navidshad/remote-browser-mcp/security/advisories/new)**.
Please do not open a public issue for anything exploitable.

There is no bounty and no SLA. This is a young project maintained by one person — you will get an
acknowledgement, and a fix or an honest "I am not going to fix this".

## What this project is, in security terms

It gives a program on another machine control of **a real, logged-in Chrome**. That is the feature.
Every session inherits your cookies, your sessions, your extensions and your IP. There is no
sandbox between the agent and your accounts, because a sandbox would remove the reason to use it.

So the threat model is not "can the agent be contained" — it cannot be. It is:

1. **Only a browser you deliberately lend.** The extension acts only inside the Chrome profile it is
   installed in. Use a dedicated profile and turn Extensions sync off; that is the isolation.
2. **Only while you are looking.** Commands drive a visible window. Chrome shows its debugging
   banner throughout, and dismissing it detaches.
3. **Only from a party holding a token.** Two of them, for two faces, and the server refuses to
   start if they are equal or absent.

## What is NOT protected, and is not a vulnerability report

- **An agent doing something you did not want, on a site you gave it access to.** The tokens
  authenticate *which program* is connected, never *what it should do*. Judgement is upstream.
- **Prompt injection from page content.** A page the agent reads can try to instruct it. Nothing
  here can prevent that; treat every browsing session as reachable by whatever it reads.
- **Anyone with your tokens.** They are bearer credentials for a logged-in browser. Treat them the
  way you would treat the browser.

## What IS worth reporting

- A way to reach the WebSocket or MCP face without a valid token, or to make the server serve
  either face unauthenticated.
- A way for one MCP session to touch another session's tabs.
- A way for a page to reach the extension's privileged surfaces — its service worker, its stored
  profiles, or `chrome.debugger`.
- A way to make the extension act in a Chrome profile it was not installed in.
- A token, or any other credential, appearing in a log, an artifact or a crash report.

## Supported versions

The latest release only. There are no backports.
