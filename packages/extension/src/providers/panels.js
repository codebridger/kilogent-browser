// Which panels the popup shows — the popup's half of the provider seam.
//
// SEPARATE FROM `providers/index.js`, and not for tidiness. That file lists TRANSPORTS, which
// import `executor.js` and the CDP layer; the popup is a page and needs none of it. Importing one
// list would drag the whole driver into a window that only draws buttons, on every popup open.
//
// So a fork adds a line in two places — here and in `providers/index.js` — and each line sits next
// to the thing it configures. The worker and the popup are genuinely different programs that
// happen to ship in the same directory.

import { createBridgePanel } from "./bridge/popup.js";

/**
 * Factories, in display order. Each returns a Panel:
 *
 *   name     string, for logs
 *   mount    (root: HTMLElement) => void   fill your own section; wire your own listeners
 *   render   (snapshot: object) => void    called on mount and then on every poll
 *   summary  string, OPTIONAL — present means "fold me into a <details> with this label"
 *
 * A panel owns ITS OWN MARKUP. `popup.html` is core and a fork must not edit it — which is only
 * possible because nothing in it is panel-specific.
 *
 * @type {Array<(deps: any) => {name: string, mount: Function, render: Function}>}
 */
export const PANELS = [createBridgePanel];
