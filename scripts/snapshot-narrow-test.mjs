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
  childNodes: [],
  getAttribute: (k) => attrs[k] ?? null,
  hasAttribute: (k) => k in attrs,
  getBoundingClientRect: () => ({ width: 100, height: 20 }),
  ...attrs,
});

/** A DOM text node. nodeType 3 is what `directText` keys on. */
const textNode = (value) => ({ nodeType: 3, nodeValue: value });

/**
 * Build an element whose children may be elements OR strings.
 *
 * `children` gets the ELEMENTS and `childNodes` gets EVERYTHING, because that is the distinction
 * `directText` depends on: it must see this element's own words and not its descendants'. A stub
 * that put text into `children`, or elements into neither, would make the no-duplication test pass
 * for the wrong reason — the exact trap this file's header warns about.
 */
const node = (tag, kids, attrs = {}) => {
  const e = el(tag, '', attrs);
  e.children = kids.filter((k) => typeof k !== 'string');
  e.childNodes = kids.map((k) => (typeof k === 'string' ? textNode(k) : k));
  e.innerText = kids.map((k) => (typeof k === 'string' ? k : k.innerText)).join(' ');
  return e;
};

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
ok(/nothing matches/.test(miss) && /3 lines/.test(miss),
  'a miss reports the page size rather than looking like an empty page');

const one = snapshot({ ref: 'e2' });
ok(one.includes('Cancel') && !one.includes('Pay now'), 'ref returns just that element');
ok(/no element e99/.test(snapshot({ ref: 'e99' })),
  'a stale ref says to take a fresh snapshot rather than returning nothing');



// ── page text (the gap a real agent found on example.com) ────────────────────────────────────
//
// `interesting()` admitted actionable roles and headings only, so a page's WORDS were absent from
// every snapshot — and `browser_read`'s `text` format routes here too, so an agent asked to read a
// page could not read one. It reported the heading and the link correctly and said the paragraph
// "didn't come through".
console.log('\nSNAPSHOT_FN page text:');

function snapText(body, narrow) {
  globalThis.window = { __rbm: {} };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  globalThis.document = { body, title: 'Example Domain' };
  globalThis.location = { href: 'https://example.com/' };
  globalThis.Node = { ELEMENT_NODE: 1 };
  return SNAPSHOT_FN.call(globalThis, narrow ?? null);
}

// The real page, in the shape that produced the bug report.
const examplePage = node('DIV', [
  node('H1', ['Example Domain']),
  node('P', ['This domain is for use in documentation examples without needing permission.']),
  node('A', ['Learn more'], { href: 'https://iana.org/domains/example' }),
]);

const page = snapText(examplePage);
ok(page.includes('This domain is for use in documentation examples'),
  'a paragraph now appears — the whole point');
ok(page.includes('heading "Example Domain"'), 'and the heading still does');
ok(page.includes('link "Learn more"'), 'and the link still does');

// An actionable element's words are already its name. Emitting them again would bill the agent
// twice for the same sentence and make `find` report double.
const linkLines = page.split('\n').filter((l) => l.includes('Learn more'));
ok(linkLines.length === 1, 'an actionable element is NOT also emitted as text');

// DIRECT text only. If this read innerText, the wrapper would repeat everything beneath it.
const nested = snapText(node('DIV', [node('DIV', [node('P', ['Only once.'])])]));
ok(nested.split('Only once.').length - 1 === 1, 'a nested sentence is emitted exactly once');

// The page's stylesheet must not be able to decide that an agent reads source code.
const scripty = node('DIV', [
  node('SCRIPT', ['var secret = 1;']),
  node('STYLE', ['body{color:red}']),
  node('P', ['Real words.']),
]);
const scriptOut = snapText(scripty);
ok(!scriptOut.includes('var secret'), 'SCRIPT text is never emitted, whatever the page styles it as');
ok(!scriptOut.includes('color:red'), 'nor STYLE');
ok(scriptOut.includes('Real words.'), 'but real prose beside them is');

ok(snapText(node('DIV', [node('P', ['  spaced   out\n  words '])])).includes('spaced out words'),
  'whitespace is collapsed, so a pretty-printed page does not cost extra');

// Refs are for browser_act, and clicking a paragraph is not a thing.
const proseOnly = snapText(node('DIV', [node('P', ['Just words.'])]));
ok(!/text "Just words\." \[ref=/.test(proseOnly), 'text lines carry no ref');

ok(snapText(examplePage, { find: 'documentation' }).includes('This domain is for use'),
  'find matches text lines too — the narrowing that matters on a long page');

// Prose has no ceiling the way controls do, and this string goes into an agent's context.
const huge = node('DIV', Array.from({ length: 4000 }, (_, i) => node('P', ['Sentence number ' + i + ' padding padding padding.'])));
const clamped = snapText(huge);
ok(clamped.length <= 40000 + 200, 'a huge page is clamped rather than sent whole');
ok(/truncated: \d+ of \d+ lines dropped/.test(clamped), 'and it says how much it dropped');
ok(clamped.includes('`find`'), 'and points at the tool that gets the rest');
ok(!/\n\s*- text "[^"]*$/.test(clamped), 'the cut lands on a line boundary, never mid-element');

console.log(failures === 0 ? '\n✅ snapshot narrowing passed' : `\n❌ ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
