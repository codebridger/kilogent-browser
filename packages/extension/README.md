# Kilogent Browser (extension)

Lends this Chrome profile to a workspace so agents can use sites you are already signed in to.
They never see a password, and they never see a tab you opened.

There is **no build step**. The directory you are reading is the extension — load it as-is.

## Install it locally

1. `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → choose this directory (`packages/extension`).
3. Click the extension → **Sign in with Kilogent**. A tab opens at `crew.kilogent.com/connect-browser`
   with the code pre-filled; approve it there.
4. Back in the popup, tick the workspaces this browser should be offered to.

That is all the setup there is. Nothing else is typed — the extension ships knowing one public URL
and learns the rest at runtime.

**Approving does not share your browser.** It only lets this browser *offer* itself. Sharing it,
and allowing a particular agent to drive it for a particular length of time, both happen in Kilogent
under **Settings › Browsers**, and both belong to you rather than to a captain.

## The three locks

All three must be open, and each is held by a different person:

| Lock | Meaning | Who sets it |
|---|---|---|
| **Grant** | this agent may drive browsers at all | a captain, in the agent editor |
| **Share** | agents may drive *this* browser | you, in Kilogent |
| **Permission** | they may, right now, for this long | you, in Kilogent |

A captain can throw your browser off their workspace. A captain can never share it, and can never
grant themselves permission on it. That asymmetry is why it is safe to be asked to install this.

## What it will not do

- No JavaScript execution, no cookie or session reading, no file downloads.
- **No coordinate clicking** — an agent can only act on elements it can name, so every action is
  auditable.
- **It cannot touch a tab you opened.** Every session opens its own tabs, in its own tab group.
  (`adoptActiveTab()` used to break this and was deleted.)
- Nothing reaches a closed Chrome or a sleeping laptop; the agent is told so and works around it.

Chrome shows a permanent **"Kilogent Browser is debugging this browser"** strip while a tab is being
driven. There is no way to suppress it, and that is fine — it is the honest signal.

## Blocked addresses

Your own list lives in the popup, on your machine. A workspace has its own list too, and the
**effective policy is the union** — a captain can only ever add to what you have blocked, never
shorten it.

Matching is on the **exact origin**, so `bank.example.com` does not cover
`secure.bank.example.com` — add each one you mean. The same property is what makes
`bank.example.com.evil.test` fail to match. A bare host is stored for **both** `http` and `https`,
because an origin carries its scheme.

## Advanced — self-hosted bridge

The original mode is still here, behind the disclosure at the bottom of the popup: point this
browser at a bridge you run yourself, with a URL and a shared token. It needs no Kilogent account, it
is this repo's own dev loop, and it is why the whole thing is worth open-sourcing.

Both modes can run at once.

## Tests

```
npm run test:kilogent        # the Kilogent transport, against a REAL relay — no Chrome needed
npm run test:mock        # the bridge mode's CDP + session model
npm run test:profiles    # multiple bridges, per-profile tab isolation
```

`test:kilogent` runs the actual relay from the published `@lumi.ai/relay` package and makes this
extension satisfy it. That matters because the two ends live in **different repositories** with
nothing linking them at compile time — each side testing its own belief about the wire format is
exactly the class of bug that ships broken.

What those harnesses do **not** cover is the service worker's own lifecycle — eviction, the alarm,
a session replaced in place. Those need a real Chrome.

Already checked by hand, so you need not wonder: all four hosts this extension talks to
(`cloudfunctions.net`, `firestore.googleapis.com`, `identitytoolkit.googleapis.com`,
`securetoken.googleapis.com`) answer a CORS preflight from a `chrome-extension://` origin,
reflecting the origin and allowing `content-type` + `authorization`.

## A note on the extension ID

`manifest.json` deliberately carries no `"key"`. It would need an RSA private half to be generated
and kept, and nothing depends on a stable id any more — the device-flow sign-in removed that
requirement. If you later host a `.crx` or push this through enterprise policy, generate one with
**chrome://extensions → Pack extension**, keep the `.pem`, and add the public half here.
