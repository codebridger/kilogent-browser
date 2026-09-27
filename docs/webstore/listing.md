# Chrome Web Store listing — Kilogent Browser

Everything the Developer Dashboard asks for, ready to paste. The **API cannot set any of this**. It
only uploads the zip and submits it (see MAINTAINING.md → "The Chrome Web Store"), so this file is
the source of truth and the dashboard is a copy of it. Change it here first.

What the zip carries by itself, and so updates with every release: the **name** and **summary**
(`manifest.json` → `name`, `description`) and the **icon** (`packages/extension/icons/`).

---

## Package

Upload `extension-<version>-prod.zip` from the GitHub Release. **Never the `-dev` zip**, which
signs in to the development project.

## Store listing tab

**Description** (paste as-is; the store renders plain text):

```
Kilogent Browser lends this Chrome to your Kilogent workspace, so your agents can work in the sites you are already signed in to — your CRM, your analytics, your internal tools — without ever being given a password.

HOW IT WORKS
1. Sign in with Kilogent. A tab opens on your workspace; approve this browser there, once.
2. Offer it to your workspaces. Tick the ones that may ask to use it.
3. Share it and grant permission in Kilogent, on the workspace's Settings › Browsers. You choose which agents may drive it, and for how long.

When an agent needs a website, it opens its own tabs in this browser, inside its own tab group, and works there: it reads the page, clicks named elements, types and selects, and can take a screenshot to check its work. You can watch it happen.

THREE LOCKS, AND TWO OF THEM ARE ONLY YOURS
• Grant — this agent may use browsers at all. Set by a workspace captain.
• Share — agents may use this particular browser. Set by you.
• Permission — they may, right now, for as long as you say. Set by you.
All three must be open. A workspace admin can remove your browser from their workspace, but can never share it or grant permission on it for you.

WHAT IT WILL NEVER DO
• Read your passwords, cookies or saved sessions.
• Touch a tab you opened. Agents only ever work in tabs they opened themselves.
• Run its own scripts on a page, download files, or click by screen coordinates — every action targets an element it can name, so every action is auditable.
• Open a site on your blocklist. Your list lives in the extension and always applies; a workspace can add to it and can never shorten it.

ALWAYS VISIBLE
While an agent drives a tab, Chrome shows its own "Kilogent Browser started debugging this browser" banner. It cannot be hidden, and that is deliberate. Close the tab, sign out, or turn sharing off in Kilogent, and the agent stops.

Nothing reaches a closed Chrome or a sleeping laptop — the agent is told so and works around it.

Kilogent Browser needs a Kilogent account. Learn more at https://kilogent.com
```

- **Category:** Productivity → Workflow & Planning
- **Language:** English
- **Store icon:** `store-icon-128.png`
- **Screenshots:** `screenshot-1.png`, `screenshot-2.png` (1280×800)
- **Small promo tile:** `promo-small-440x280.png`
- **Marquee promo tile:** `promo-marquee-1400x560.png`
- **Official URL:** kilogent.com (only selectable after the domain is verified in Search Console for the publisher account; otherwise leave it empty)
- **Homepage URL:** https://kilogent.com
- **Support URL:** https://kilogent.com/contact
- **Mature content:** No

## Privacy tab

**Single purpose:**

```
Lets the user's Kilogent agents operate websites in this Chrome profile — in tabs the agents open themselves, inside their own tab group — only after the user has shared this browser with a workspace and granted an agent permission for a limited time.
```

**Permission justifications:**

| Permission | Justification (paste) |
|---|---|
| `debugger` | Drives only the tabs an agent opened, through the Chrome DevTools Protocol: reading the page's structure, clicking named elements, typing, selecting and taking screenshots. It is never attached to a tab the user opened, and Chrome shows its debugging banner the whole time. |
| `tabs` | Opens, navigates and closes the agent's own tabs, and tells them apart from the user's tabs so the user's are never touched. |
| `tabGroups` | Puts each agent session's tabs in their own labelled, coloured tab group, so the user can see at a glance what an agent is doing. |
| `storage` | Keeps the Kilogent sign-in session, this browser's name, the chosen workspaces and the user's blocklist on this device. |
| `alarms` | Wakes the service worker to keep the connection to the workspace alive and resume a pending sign-in after Chrome suspends it. |
| Host permission `<all_urls>` | The agent can be asked to work on any website the user uses, so the set of sites cannot be known in advance. Every navigation is checked against the user's blocklist first, and only tabs the agent opened are ever accessed. |

**Remote code:** No, I am not using remote code. (Every script ships in the package; the extension
loads no code from the network.)

**Data usage.** Tick these:

- [x] **Personally identifiable information:** the Kilogent account email, shown in the popup.
- [x] **Authentication information:** the Kilogent sign-in token.
- [x] **Website content:** the page structure, text and screenshots of tabs **the agent opened**, sent
  to the user's own workspace so the agent can act on them.

Leave unticked: health, financial, personal communications, location, web history (the user's own
browsing is never read), user activity (no keystroke or mouse monitoring of the user).

Certify all three:
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://kilogent.com/legal#privacy-extension

## Distribution tab

- **Payments:** Free
- **Visibility:** Public
- **Regions:** All regions

## Account (publisher-level, once)

- **Service account for the API:** `chrome-webstore-publisher@kilogent-crew-prod.iam.gserviceaccount.com`

---

## Regenerating the images

`source/` holds the HTML they were rendered from. Slide 1 embeds the **real** production popup, with
`source/stub.js` standing in for Chrome's APIs:

1. `node scripts/package-extension.mjs --out /tmp/dist`, unzip the `-prod` zip into `site/popup/`.
2. In that copy, load `stub.js` before `popup.js` in `popup.html` (save it as `popup-stub.html`).
3. Put `source/*` in `site/slides/` and serve `site/` on port 8765 (`python3 -m http.server 8765`).
4. Render each page with headless Chrome at its exact size, for example:
   `"Google Chrome" --headless=new --hide-scrollbars --window-size=1280,800 --virtual-time-budget=5000 --screenshot=screenshot-1.png http://127.0.0.1:8765/slides/s1.html`
5. **Flatten to RGB.** The store refuses PNGs with an alpha channel for screenshots and tiles.
