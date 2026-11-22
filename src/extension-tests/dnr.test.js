import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDnr, loadDnr, settle } from './harness.js';

const Dnr = loadDnr();
const BASE = 'chrome-extension://focusbear/blocked.html';
const BLOCK_ALL = '^https?://.*';
const NOW = 1_700_000_000_000;

const build = (state, dnr = createFakeDnr()) =>
  Dnr.buildRules({ now: NOW, ...state }, { blockedPageBase: BASE, supported: Dnr.createRegexChecker(dnr.isRegexSupported) });

const filters = (rules) => [...rules].map((rule) => rule.condition.regexFilter);
// Chrome matches these with RE2, case-insensitive; the patterns used here mean the same in JS.
const opens = (regex, url) => new RegExp(regex, 'i').test(url);
const blockAll = (rules) => rules.filter((rule) => rule.condition.regexFilter === BLOCK_ALL);

test('the allow list goes into session rules, the block list into dynamic rules', async () => {
  const plan = await build({ blocklist: ['facebook.com'], allowOnly: ['wikipedia.org'] });

  assert.equal(blockAll(plan.session).length, 1);
  assert.equal(blockAll(plan.dynamic).length, 0, 'the block-everything rule must not survive a browser restart');
  assert.ok(plan.session.every((rule) => rule.id >= Dnr.SESSION_ID_BASE));
  assert.ok(plan.dynamic.every((rule) => rule.id < Dnr.SESSION_ID_BASE));
  assert.equal(plan.dynamic.length, 1);
  assert.equal(plan.dynamic[0].action.redirect.regexSubstitution, BASE + '#\\0');
  assert.equal(blockAll(plan.session)[0].action.redirect.regexSubstitution, BASE + '?reason=allow_list#\\0');

  const none = await build({ blocklist: ['facebook.com'], allowOnly: null });
  assert.equal(none.session.length, 0);
});

test('an allow-list rule opens the site, not an address that only mentions it', () => {
  const regex = Dnr.allowRegex('wikipedia.org');
  assert.equal(opens(regex, 'https://wikipedia.org/'), true);
  assert.equal(opens(regex, 'https://en.wikipedia.org/wiki/Bear?x=1'), true);
  assert.equal(opens(regex, 'http://WWW.Wikipedia.org'), true);
  assert.equal(opens(regex, 'https://youtube.com/?wikipedia.org'), false);
  assert.equal(opens(regex, 'https://youtube.com/watch?v=1&u=wikipedia.org'), false);
  assert.equal(opens(regex, 'https://youtube.com/#wikipedia.org'), false);
  assert.equal(opens(regex, 'https://youtube.com/watch/wikipedia.org'), false);
  assert.equal(opens(regex, 'https://wikipedia.org@youtube.com/'), false);

  const withPath = Dnr.allowRegex('github.com/focus-bear');
  assert.equal(opens(withPath, 'https://github.com/Focus-Bear/app?tab=1'), true);
  assert.equal(opens(withPath, 'https://github.com/other'), false);
  assert.equal(opens(withPath, 'https://evil.com/?github.com/focus-bear'), false);

  const wild = Dnr.allowRegex('*.google.com');
  assert.equal(opens(wild, 'https://docs.google.com/document'), true);
  assert.equal(opens(wild, 'https://youtube.com/?a.google.com'), false);

  const own = Dnr.alwaysAllowedRegex('focusbear.io');
  assert.equal(opens(own, 'https://dashboard.focusbear.io/home'), true);
  assert.equal(opens(own, 'https://evil.com/x.focusbear.io'), false);
  assert.equal(opens(own, 'https://notfocusbear.io/'), false);
});

test('a non-ASCII site becomes punycode, so Chrome takes the rule', async () => {
  const plan = await build({ blocklist: ['café.fr'], allowOnly: ['münchen.de'] });
  for (const regex of [...filters(plan.dynamic), ...filters(plan.session)]) {
    assert.match(regex, /^[\x20-\x7E]*$/);
  }
  assert.equal(plan.skipped, 0);
  assert.equal(opens(filters(plan.dynamic)[0], 'https://xn--caf-dma.fr/menu'), true);
  assert.ok(filters(plan.session).some((regex) => opens(regex, 'https://www.xn--mnchen-3ya.de/')));
});

test('a regex Chrome refuses is skipped, the rest still applies', async () => {
  const dnr = createFakeDnr({ unsupported: (regex) => regex.includes('(?=') });
  const plan = await build({ blocklist: ['.*(?=bad).*', 'facebook.com', 'bücher\\.de.*'], allowOnly: ['wikipedia.org'] }, dnr);

  assert.equal(plan.skipped, 2, 'the lookahead and the non-ASCII regex');
  assert.deepEqual(filters(plan.dynamic), ['.*facebook\\.com.*']);
  const result = await Dnr.applyRules(dnr, plan);
  assert.deepEqual({ ...result }, { dynamicOk: true, sessionOk: true });
  assert.equal(dnr.rules.dynamic.length, 1);
  assert.equal(blockAll(dnr.rules.session).length, 1);
});

test('isRegexSupported is asked once per regex, not on every rebuild', async () => {
  const dnr = createFakeDnr();
  let asked = 0;
  const supported = Dnr.createRegexChecker((options) => { asked++; return dnr.isRegexSupported(options); });
  const state = { blocklist: ['facebook.com', 'x.com'], whitelist: [], allowOnly: null, now: NOW };
  await Dnr.buildRules(state, { blockedPageBase: BASE, supported });
  await Dnr.buildRules(state, { blockedPageBase: BASE, supported });
  assert.equal(asked, 2);
  assert.equal(await Dnr.createRegexChecker(() => { throw new Error('no'); })('a', false), false);
});

test('block list, temporary unblocks and allow list together stay within 1000 regex rules', async () => {
  const blocklist = Array.from({ length: 1500 }, (_, i) => `site${i}.com`);
  const allowOnly = Array.from({ length: 500 }, (_, i) => `allowed${i}.org`);
  const whitelist = Array.from({ length: 150 }, (_, i) => ({ pattern: `site${i}.com`, type: 'domain', expiresAt: NOW + 60000 }));
  const dnr = createFakeDnr();
  const plan = await build({ blocklist, allowOnly, whitelist }, dnr);

  assert.equal(plan.dynamic.length + plan.session.length, Dnr.MAX_REGEX_RULES);
  assert.equal(blockAll(plan.session).length, 1);
  assert.equal(plan.session.length, Dnr.MAX_ALLOW_RULES + 1);
  assert.equal(plan.dynamic.filter((rule) => rule.action.type === 'allow').length, Dnr.MAX_UNBLOCK_RULES);
  assert.ok(plan.dropped > 0);
  const result = await Dnr.applyRules(dnr, plan);
  assert.deepEqual({ ...result }, { dynamicOk: true, sessionOk: true }, 'Chrome (1000 regex rules) takes the set');

  const blockOnly = await build({ blocklist, allowOnly: null });
  assert.equal(blockOnly.dynamic.length, Dnr.MAX_REGEX_RULES);
});

test('no temporary unblocks while "Immediately block" is on; expired ones are left out', async () => {
  const whitelist = [
    { pattern: 'facebook.com', type: 'domain', expiresAt: NOW + 60000 },
    { pattern: 'https://x.com/Home?a=1', type: 'exact', expiresAt: NOW + 60000 },
    { pattern: 'old.com', type: 'domain', expiresAt: NOW - 1 },
  ];
  const plan = await build({ blocklist: ['facebook.com'], whitelist });
  const allow = plan.dynamic.filter((rule) => rule.action.type === 'allow');
  assert.equal(allow.length, 2);
  assert.equal(opens(allow[0].condition.regexFilter, 'https://m.facebook.com/x'), true);
  assert.equal(opens(allow[0].condition.regexFilter, 'https://evil.com/a.facebook.com'), false);
  assert.equal(opens(allow[1].condition.regexFilter, 'https://x.com/Home?a=1'), true);
  assert.equal(opens(allow[1].condition.regexFilter, 'https://x.com/Home?a=12'), false);

  const strict = await build({ blocklist: ['facebook.com'], whitelist, immediatelyBlock: true });
  assert.equal(strict.dynamic.filter((rule) => rule.action.type === 'allow').length, 0);
});

test('when Chrome refuses the allow-list rules, the old block-everything rule is removed, not kept', async () => {
  const dnr = createFakeDnr({ failUpdates: ({ kind, addRules }) => kind === 'session' && addRules.length > 0 && dnr.armed });
  await Dnr.applyRules(dnr, await build({ blocklist: [], allowOnly: ['wikipedia.org'] }, dnr));
  assert.equal(blockAll(dnr.rules.session).length, 1);

  dnr.armed = true;
  const logged = [];
  const result = await Dnr.applyRules(dnr, await build({ blocklist: [], allowOnly: ['wikipedia.org', 'docs.google.com'] }, dnr), (line) => logged.push(line));

  assert.equal(result.sessionOk, false);
  assert.equal(dnr.rules.session.length, 0, 'retried with the allow-list rules removed');
  assert.match(logged.join('\n'), /Allow list rules were refused/);
});

test('allow-list rules an older version left in the dynamic rules are removed', async () => {
  const legacy = [
    { id: 1, priority: 3, action: { type: 'redirect' }, condition: { regexFilter: '.*facebook\\.com.*' } },
    { id: 2, priority: 2, action: { type: 'allow' }, condition: { regexFilter: '.*wikipedia\\.org.*' } },
    { id: 3, priority: 1, action: { type: 'redirect' }, condition: { regexFilter: BLOCK_ALL } },
  ];
  const dnr = createFakeDnr();
  dnr.rules.dynamic = legacy.map((rule) => ({ ...rule }));
  await Dnr.applyRules(dnr, await build({ blocklist: ['facebook.com'], allowOnly: null }, dnr));
  assert.deepEqual(filters(dnr.rules.dynamic), ['.*facebook\\.com.*']);

  // Even when the new block-list rules are refused, the old block-everything rule goes.
  const failing = createFakeDnr({ failUpdates: ({ kind, addRules }) => kind === 'dynamic' && addRules.length > 0 });
  failing.rules.dynamic = legacy.map((rule) => ({ ...rule }));
  const result = await Dnr.applyRules(failing, await build({ blocklist: ['facebook.com'], allowOnly: null }, failing));
  assert.equal(result.dynamicOk, false);
  assert.deepEqual(failing.rules.dynamic.map((rule) => rule.id), [1], 'the previous block list is kept');
  assert.equal(blockAll(failing.rules.dynamic).length, 0);
});

test('rule updates run one after another', async () => {
  const enqueue = Dnr.createQueue();
  const order = [];
  let running = 0;
  const task = (name) => async () => {
    running++;
    assert.equal(running, 1, 'never two at once');
    order.push(name + ':start');
    await settle(3);
    order.push(name + ':end');
    running--;
  };
  const first = enqueue(task('a'));
  const failing = enqueue(async () => { throw new Error('boom'); });
  const last = enqueue(task('b'));
  await first;
  await assert.rejects(failing, /boom/);
  await last;
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
});
