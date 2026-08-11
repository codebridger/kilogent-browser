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
import { createKilogentPanel } from "./kilogent/popup.js";

/**
 * Factories, in display order. Each returns a Panel:
 *
 *   name    string, for logs
 *   mount   (root: HTMLElement) => void   fill your own section; wire your own listeners
 *   render  (snapshot: object) => void    called on mount and then on every poll
 *
 * A panel owns ITS OWN MARKUP. `popup.html` is core and a fork must not edit it — which is only
 * possible because nothing in it is panel-specific.
 *
 * @type {Array<(deps: any) => {name: string, mount: Function, render: Function}>}
 */
export const PANELS = [
  createKilogentPanel,
  // The self-hosted bridge is the ordinary path upstream and the ADVANCED one here, so it is folded
  // away. Expressed by wrapping the factory rather than by editing the panel — a fork demoting a
  // core panel must not have to fork it.
  (deps) => ({ ...createBridgePanel(deps), summary: "Advanced — self-hosted bridge" }),
];
