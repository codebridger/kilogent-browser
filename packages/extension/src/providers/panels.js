// Which panels the popup shows — the popup's half of the provider seam.
//
// SEPARATE FROM `providers/index.js`, and not for tidiness. That file lists TRANSPORTS, which
// import `executor.js` and the CDP layer; the popup is a page and needs none of it. Importing one
// list would drag the whole driver into a window that only draws buttons, on every popup open.
//
// So a fork adds a line in two places — here and in `providers/index.js` — and each line sits next
// to the thing it configures. The worker and the popup are genuinely different programs that
// happen to ship in the same directory.

import { createKilogentPanel } from "./kilogent/popup.js";

/**
 * Factories, in display order. Each returns a Panel:
 *
 *   name     string, for logs
 *   mount    (root: HTMLElement) => void   fill your own section; wire your own listeners
 *   render   (snapshot: object) => void    called on mount and then on every poll
 *   summary  string, OPTIONAL — present means "fold me into a <details> with this label"
 *
 * Each factory receives `{storage, send, openTab}` — Chrome's storage, a message sender that never
 * throws, and a way to open a tab. Everything a panel needs from the browser arrives that way, so a
 * panel is loadable outside one and `scripts/popup-test.mjs` needs no Chrome shim.
 *
 * A panel owns ITS OWN MARKUP. `popup.html` is core and a fork must not edit it — which is only
 * possible because nothing in it is panel-specific.
 *
 * @type {Array<(deps: any) => {name: string, mount: Function, render: Function}>}
 */
// THE SELF-HOSTED BRIDGE IS DELIBERATELY NOT REGISTERED IN THIS BUILD.
//
// It is not about tidiness. The bridge transport is a SECOND path to full CDP control of this
// browser, and it is trusted on nothing but a URL and a shared token somebody types into the popup.
// None of Kilogent's three locks — Ship membership, the captain's per-agent grant, the owner's
// consent — is consulted on that path, because they live in `providers/kilogent/`.
//
// Worse, so does the blocklist. `isBlocked` is referenced only by `providers/kilogent/*`, so a
// bridge session ignores the user's own "Never open these" list — while the popup, three lines
// above it, promises "Your list always applies". That sentence is true only once this is absent.
//
// So a build carrying our name offers exactly one way in. Anyone who genuinely wants the
// self-hosted bridge should run the upstream extension, which is what it is for.
//
// The FILES stay (`providers/bridge/`), unregistered rather than deleted: deleting them would mean
// re-deleting them at every merge from upstream. `scripts/check-branding.mjs` asserts they stay
// unregistered, because a merge that re-adds the line is exactly how this would come back.
export const PANELS = [createKilogentPanel];
