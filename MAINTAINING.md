# Maintaining this fork

Two jobs are described here.

1. **Taking a change from upstream** — the update loop.
2. **Making your own brand** — what a rebrand actually touches.

The second one is written from a real rebrand: this repository was "Lumi Browser" until
2026-08-11. Every step and every trap below is one that happened, not one that might.

---

## 1. The update loop

Upstream is [navidshad/remote-browser-mcp](https://github.com/navidshad/remote-browser-mcp). It
owns the core: the CDP driver, the page scripts, the connection manager, the self-hosted bridge.
We own the branding and the transport that talks to Kilogent.

### Set it up once

```bash
git remote add upstream https://github.com/navidshad/remote-browser-mcp.git
```

⚠️ **Your clone must have full history.** A shallow clone (`git clone --depth 1`, or the kind some
CI checkouts make) has no root commit, so it shares no ancestor with upstream and cannot merge from
it. Check and fix:

```bash
git rev-parse --is-shallow-repository     # false is what you want
git fetch --unshallow upstream            # if it said true
```

This is not theoretical. The first push that created this repository failed four times with
`did not receive expected object`, because the clone it came from was shallow.

### Every time

```bash
git fetch upstream
git merge upstream/main
```

Then, whether or not there was a conflict:

```bash
npm install
npm run test:kilogent     # the real relay, end to end — the one that matters
npm run test:registry     # the transport seam, including OUR transport
npm run test:snapshot
npm run test:select
npm run test:mock
npm run test:profiles
```

Then reload the extension at `chrome://extensions` and sign in once. **No test covers real Chrome**
— there is no CDP and no real page in any of them — so a manual load is part of the loop, not an
optional extra.

### What conflicts, and what to do about it

| File | Conflicts? | Why |
|---|---|---|
| `src/sw.js`, `src/executor.js`, `src/page-scripts.js`, `src/connection.js` | **never** | byte-identical to upstream — we do not edit core |
| `src/providers/registry.js`, `src/providers/bridge/` | **never** | same |
| `src/providers/kilogent/**` | **never** | upstream does not have it |
| `src/providers/index.js` | **rarely** | we add ONE import and ONE array entry; conflicts only if upstream edits the same two lines |
| `popup.js`, `popup.html` | **often** | ours are rewritten for the sign-in flow, and the popup has no provider seam yet |

`sw.js` used to conflict on every single merge, because the transport was written INTO it. It no
longer does: upstream grew a transport seam, our transport moved to `providers/kilogent/`, and the
worker is now the same file on both sides. Verify that at any time:

```bash
git fetch upstream
for f in sw.js providers/registry.js providers/bridge/index.js executor.js connection.js page-scripts.js; do
  git diff --quiet upstream/main -- "packages/extension/src/$f" \
    && echo "ok    $f" || echo "EDITED $f  ← a fork must not"
done
```

Anything that prints `EDITED` is a merge you will be resolving by hand forever. Move it into
`providers/kilogent/`, or send it upstream. (Point it at whichever upstream branch carries the
transport seam — it is `main` once that is merged.)

`test:registry` is upstream's and it walks whatever `providers/index.js` lists, so it checks OUR
transport too: that it satisfies the registry's shape, and that it does not claim `getStatus` or
`reconnect`. A fork gets that coverage without writing a line of it.

**The popup is the one that is still ours**, and it is the honest remainder: a branded popup IS the
brand, and there is no seam for it yet. Resolve it by taking upstream's structural changes and
keeping our sign-in panel. When upstream grows a popup seam, this row goes too.

### Which changes go upstream instead

Ask one question: **would this help somebody who has never heard of Kilogent?**

| Change | Where it belongs |
|---|---|
| A CDP bug, a snapshot fix, a new browser action | **upstream**, as a pull request |
| Anything in `executor.js` or `page-scripts.js` | **upstream**, always |
| Our endpoint, our auth, our storage keys, our strings | here |
| A new file under `providers/kilogent/` | here |

Sending core fixes upstream is not politeness. A fix kept here is a fix we re-merge by hand forever.

---

## 2. Making your own brand

Fork upstream, not this repository — unless you specifically want Kilogent's auth as a starting
point. What follows is the full inventory of what a rebrand touches.

### The seven places a name lives

| # | Where | What to change |
|---|---|---|
| 1 | `packages/extension/src/providers/kilogent/` | rename the directory, and the one import in `providers/index.js` |
| 2 | `packages/extension/manifest.json` | `name`, `description` — this is what Chrome shows |
| 3 | `packages/extension/popup.html` + `popup.js` | every visible string |
| 4 | `providers/<yourbrand>/config.js` → `KEYS` | the `chrome.storage` keys |
| 5 | `providers/<yourbrand>/config.js` → `DEFAULT_FUNCTIONS_BASE` | **your own endpoint** — this one is not cosmetic |
| 6 | `package.json` | `name` |
| 7 | `scripts/<yourbrand>-harness.mjs` | the harness and its npm script |

A case-preserving find-and-replace covers 1–4, 6 and 7. Number 5 is a real decision, not a rename.

### Three traps

**Do not rename a project id that happens to contain the old brand.** This repository still says
`lumi-afb7d` in `providers/kilogent/config.js`, on purpose. That is a Firebase **project id** — an identifier
somebody else's server knows. Renaming it points the extension at a project that does not exist, and
the symptom is every sign-in failing with a network error that names nothing.

**Do not rename an npm scope either.** `@lumi.ai/relay` stays as it is. `@lumi.ai` is an org on the
public registry; the brand on your box does not change who publishes the software you install.

**Renaming the storage keys signs everybody out.** The extension looks for `kilogent.session` and an
already-installed copy has `oldbrand.session`. It finds nothing, so it signs out once and the person
reconnects. That is cheap while your users are you and your colleagues, and expensive later — so do
it early or write a migration.

### Prove it before you ship it

Sweep the **code**, where a leftover is a bug:

```bash
grep -rn -i oldbrand \
  --include='*.js' --include='*.mjs' --include='*.html' --include='*.json' \
  . | grep -v node_modules
```

`--include='*.mjs'` is not optional — the harness is a `.mjs` file and it holds two live imports.
Leaving it out was a real mistake in the first draft of this page, and it would have skipped the one
file that talks to the relay.

Expect **only** the deliberate survivors: the project id and the npm scope. Anything else is a miss.

Do **not** grep the docs the same way. Prose legitimately names the old brand — this page does, and
so does the README, because describing a rename means writing both names down. Read those; do not
pattern-match them.

Then run the harnesses. `test:kilogent` starts a real relay and makes the extension satisfy it, so a
broken import or a renamed storage key fails there rather than in somebody's browser.

### The rule that makes all of this work

**A fork never edits the core.** Put your code in `providers/<yours>/` and leave `sw.js`,
`executor.js`, `page-scripts.js`, `connection.js`, `providers/registry.js` and `providers/bridge/`
exactly as upstream wrote them. That single habit is the difference between `git merge
upstream/main` being routine and being a day's work.

This fork is currently down to **one directory and three lines** of `providers/index.js` under
`src/` — plus the popup, which has no seam yet. That is what the rule buys.
