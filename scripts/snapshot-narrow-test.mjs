// SNAPSHOT_FN's narrowing, against the REAL function (no Chrome).
//
// `browser_read` has advertised `find` and `ref` since day one and silently ignored both — Crew
// forwarded them and the whole accessibility tree came back regardless, so an agent that asked for
// one row paid for the entire page every time.
//
// The DOM stub is deliberately minimal but it must match what the code actually reads: the first
// version of this used `textContent`, while `nameOf` reads `innerText`, so every element came back
// unnamed and "nothing matches" looked like a working filter. A stub that disagrees with the code
// in a way that makes the test pass is the failure mode this whole file exists to avoid.
import { SNAPSHOT_FN } from '../packages/extension/src/page-scripts.js';

let failures = 0;
const ok = (cond, m) => { console.log(`  ${cond ? '✓' : '✗'} ${m}`); if (!cond) failures++; };

const el = (tag, name, attrs = {}) => ({
  tagName: tag, innerText: name, textContent: name, disabled: false, shadowRoot: null, children: [],
  getAttribute: (k) => attrs[k] ?? null,
  hasAttribute: (k) => k in attrs,
  getBoundingClientRect: () => ({ width: 100, height: 20 }),
  ...attrs,
});

function snapshot(narrow) {
  const body = el('DIV', '');
  body.children = [
    el('BUTTON', 'Pay now'),
    el('BUTTON', 'Cancel'),
    el('INPUT', '', { type: 'text', placeholder: 'Email address' }),
  ];
  globalThis.window = { __rbm: {} };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  globalThis.document = { body, title: 'Checkout' };
  globalThis.location = { href: 'https://shop.test/checkout' };
  globalThis.Node = { ELEMENT_NODE: 1 };
  return SNAPSHOT_FN.call(globalThis, narrow);
}

console.log('SNAPSHOT_FN narrowing:');

const full = snapshot(null);
ok(full.includes('[ref=e1]') && full.includes('[ref=e3]'), 'no narrowing returns the whole tree');

const found = snapshot({ find: 'pay' });
ok(found.includes('Pay now'), 'find returns the matching element');
ok(!found.includes('Cancel'), 'and drops the ones that do not match');
ok(found.includes('[ref=e1]'), 'refs survive narrowing — they are what browser_act needs');
ok(/1 of 3/.test(found), 'and it says how many of how many, so an agent knows to widen');

ok(snapshot({ find: 'PAY' }).includes('Pay now'), 'matching is case-insensitive');

const miss = snapshot({ find: 'nothing-here' });
ok(/nothing matches/.test(miss) && /3 elements/.test(miss),
  'a miss reports the page size rather than looking like an empty page');

const one = snapshot({ ref: 'e2' });
ok(one.includes('Cancel') && !one.includes('Pay now'), 'ref returns just that element');
ok(/no element e99/.test(snapshot({ ref: 'e99' })),
  'a stale ref says to take a fresh snapshot rather than returning nothing');

console.log(failures === 0 ? '\n✅ snapshot narrowing passed' : `\n❌ ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
