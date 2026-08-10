// SELECT_OPTION_FN, against the REAL function (no Chrome).
//
// Choosing from a native <select> was REFUSED for months, on correct reasoning that had the wrong
// conclusion: clicking one opens a list the operating system draws, which CDP input cannot reach.
// True — and irrelevant, because the popup is only a way of asking a human. The state is a
// property, so we set the property and fire the events a real choice fires.
//
// The stub below is minimal but it must agree with what the code READS — a stub that disagrees in
// a way that makes the test pass is the failure this file exists to prevent (see
// snapshot-narrow-test.mjs, where `textContent` vs `innerText` made "nothing matches" look like a
// working filter). Two things here earn their keep: `HTMLSelectElement.prototype.value` is a real
// accessor, because the code sets THROUGH it rather than assigning; and the trace records order,
// because clearing React's value tracker after the event instead of before would still pass every
// value assertion while silently doing nothing on a React page.
import { SELECT_OPTION_FN } from '../packages/extension/src/page-scripts.js';

let failures = 0;
const ok = (cond, m) => { console.log(`  ${cond ? '✓' : '✗'} ${m}`); if (!cond) failures++; };

/** A <select> whose options are `[label, value, disabled?]`. */
function select(options, over = {}) {
  const trace = [];
  const el = {
    tagName: 'SELECT',
    disabled: false,
    selectedIndex: -1,
    _value: '',
    _valueTracker: { setValue: (v) => trace.push(`tracker:${v === '' ? 'cleared' : v}`) },
    options: options.map(([label, value, off]) => ({ label, text: label, value, disabled: !!off })),
    scrollIntoView() {},
    focus() { trace.push('focus'); },
    dispatchEvent(e) { trace.push(`${e.type}${e.bubbles ? '' : ':nobubble'}`); return true; },
    ...over,
  };
  // The prototype accessor the code sets through. Assigning `el.value = x` directly would bypass
  // React's tracker on a real page, so the code deliberately does not — and neither does this.
  const proto = {};
  Object.defineProperty(proto, 'value', {
    get() { return this._value; },
    set(v) { this._value = v; trace.push(`set:${v}`); },
    configurable: true,
  });
  Object.setPrototypeOf(el, proto);

  globalThis.window = { __rbm: { elements: { e1: el } }, HTMLSelectElement: { prototype: proto } };
  globalThis.Event = class { constructor(type, init) { this.type = type; this.bubbles = !!(init && init.bubbles); } };
  return { el, trace, run: (value) => SELECT_OPTION_FN.call(globalThis, { ref: 'e1', value }) };
}

const COUNTRIES = [['United Kingdom', 'gb'], ['United States', 'us'], ['Uganda', 'ug']];

console.log('SELECT_OPTION_FN:');

{
  const { el, trace, run } = select(COUNTRIES);
  const r = run('United States');
  ok(r.matched === true && r.label === 'United States', 'exact label matches');
  ok(el.selectedIndex === 1 && el._value === 'us', 'and the element really moved');
  ok(trace.includes('input') && trace.includes('change'), 'both events fire — a page listens for one or the other');
  ok(!trace.some((t) => t.endsWith(':nobubble')), 'and they bubble, or a delegated listener never sees them');
  // `indexOf(...) < indexOf('change')` ALONE is vacuous — a tracker that is never touched gives
  // -1, and -1 is less than everything. The membership check is what makes this an assertion.
  ok(
    trace.includes('tracker:cleared') && trace.indexOf('tracker:cleared') < trace.indexOf('change'),
    "React's value tracker is cleared BEFORE the event, or React drops it as a value it already has",
  );
}

ok(select(COUNTRIES).run('us').matched === true, 'the option value matches too, not just its label');
ok(select(COUNTRIES).run('Uga').label === 'Uganda', 'a unique substring is enough');
ok(select(COUNTRIES).run('united states').label === 'United States', 'matching is case-insensitive');
ok(select(COUNTRIES).run('  United States  ').matched === true, 'and tolerant of the whitespace a model adds');

{
  // The reason ambiguity is a miss rather than first-wins: both readings are plausible and only
  // one is the address the person actually lives at.
  const r = select([['UK', 'gb'], ['UK (Northern Ireland)', 'gb-ni']]).run('UK');
  ok(r.matched === true && r.value === 'gb', 'an EXACT label beats a substring of a longer one');

  const amb = select([['Ship to UK', 'a'], ['Ship to UK islands', 'b']]).run('UK');
  ok(amb.matched === false && amb.ambiguous.length === 2, 'a substring matching two options refuses and names both');
}

{
  const r = select(COUNTRIES).run('Atlantis');
  ok(r.matched === false && !r.ambiguous, 'an option that is not there is a miss');
  ok(r.options.join(',') === 'United Kingdom,United States,Uganda', 'and the real options come back, so the retry is informed');
}

{
  // Every "Choose a country…" placeholder is this. Selecting it would look like a choice and then
  // fail on submit, which is a worse outcome than being told.
  const { trace, run } = select([['Choose…', '', true], ['Blue', 'blue']]);
  const r = run('Choose…');
  ok(r.matched === false && r.optionDisabled === 'Choose…', 'a disabled option is refused by name');
  ok(!trace.some((t) => t.startsWith('set:')), 'and nothing was changed on the way to refusing');
}

{
  // Duplicate values are legal — `<option value="">` twice, or a list that repeats a code — and
  // `value =` picks the FIRST of them. Verified against a real browser, which also corrected the
  // reason this test was originally written for: an option with no `value` ATTRIBUTE does not have
  // "", it has its own text. The duplicate case is the real one, so the test kept the assertion
  // and lost the wrong justification.
  const { el, run } = select([['Yes', ''], ['No', '']]);
  const r = run('No');
  ok(r.matched === true && el.selectedIndex === 1,
    'options that share a value are told apart by INDEX — setting value alone would pick the first');
}

{
  const { run } = select(COUNTRIES, { tagName: 'DIV' });
  const r = run('United States');
  ok(r.notASelect === true && r.tag === 'div',
    'a page-drawn dropdown is reported as such — it IS reachable, just by clicking');
}

ok(select(COUNTRIES, { disabled: true }).run('Uganda').disabled === true, 'a disabled <select> is refused');
ok(select(COUNTRIES).run('').matched === false, 'an empty choice is a miss, not the first option');

{
  globalThis.window = { __rbm: { elements: {} } };
  ok(SELECT_OPTION_FN.call(globalThis, { ref: 'e9' }).found === false, 'a stale ref is reported, not guessed at');
}

console.log(failures === 0 ? '\n✅ select option passed' : `\n❌ ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
