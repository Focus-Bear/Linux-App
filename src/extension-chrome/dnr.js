// Chrome's declarativeNetRequest rules for the block list, the temporary
// unblocks and an allow list: what the rules are, and how they are installed.
//
// No direct chrome.* calls in here (the API object is passed in), so this is
// tested with `node --test` (src/extension-tests/dnr.test.js). Loaded by
// importScripts() after matching.js. Everything is on `FocusBearDnr`.
//
// Where the rules live, and why:
//   dynamic rules  the block list and the temporary unblocks. They survive a
//                  browser restart, so blocked sites stay blocked before the
//                  service worker has started.
//   session rules  an allow list: its sites, and the rule that sends every
//                  other page to the block page. They are gone when the
//                  browser closes. They used to be dynamic rules too, replaced
//                  in one all-or-nothing update: one rule Chrome refused (a
//                  non-ASCII site, a regex it does not support, too many
//                  rules) made the update fail, and the old "block every page"
//                  rule stayed for good, also with the app closed.
(function (root) {
  'use strict';

  const M = root.FocusBearMatching;

  // Chrome accepts 1000 regex rules. Everything here is a regex rule, so the
  // block list, the temporary unblocks and the allow list share that budget.
  const MAX_REGEX_RULES = 1000;
  const MAX_UNBLOCK_RULES = 100;
  const MAX_ALLOW_RULES = 300;
  // Session rule ids start here so they can never collide with dynamic ones.
  const SESSION_ID_BASE = 100000;

  // Priorities: temporary unblocks (4) beat the block list (3), which beats an
  // allow list's sites (2), which beat its block-everything-else rule (1).
  const PRIORITY_UNBLOCK = 4;
  const PRIORITY_BLOCK = 3;
  const PRIORITY_ALLOWED = 2;
  const PRIORITY_BLOCK_ALL = 1;

  const SCHEME = '^https?://';
  // "user:password@" in front of the host. It must never count as the host.
  const USERINFO = '([^/?#]*@)?';
  const HOST_CHARS = '[^/?#@]*';
  const AFTER_HOST = '([/?#].*)?$';

  /** regexFilter for a temporary unblock ({pattern, type}). */
  function unblockRegex(entry) {
    if (entry.type === 'domain') {
      return `${SCHEME}${USERINFO}(${HOST_CHARS}\\.)?${M.escapeRegex(entry.pattern.toLowerCase())}(:[0-9]+)?${AFTER_HOST}`;
    }
    return `${SCHEME}${M.escapeRegex(M.stripProtocol(entry.pattern))}$`;
  }

  /** regexFilter for a block-list entry, or '' when the entry blocks nothing. */
  function blockRegex(pattern) {
    if (typeof pattern !== 'string' || !pattern.trim()) return '';
    if (M.isRegexPattern(pattern)) return `.*${pattern}.*`;
    const text = M.blockText(pattern);
    // .* on both sides so \0 in the redirect is the whole address.
    return text ? `.*${M.escapeRegex(text)}.*` : '';
  }

  /** regexFilter for a host that an allow list never blocks. */
  function alwaysAllowedRegex(host) {
    return `${SCHEME}${USERINFO}(${HOST_CHARS}\\.)?${M.escapeRegex(host)}(:[0-9]+)?${AFTER_HOST}`;
  }

  /**
   * regexFilter for an allow-list entry, or '' when there is nothing to match.
   * Same rule as FocusBearMatching.matchesEntry: an entry without "/" is looked
   * for in the host only, one with "/" in host + path. Never in the query.
   */
  function allowRegex(entry) {
    const pattern = M.allowPattern(entry);
    if (!pattern) return '';
    const parts = pattern.split('*').map(M.escapeRegex);
    if (!pattern.includes('/')) {
      return `${SCHEME}${USERINFO}${HOST_CHARS}${parts.join(HOST_CHARS)}${HOST_CHARS}${AFTER_HOST}`;
    }
    return `${SCHEME}[^?#]*${parts.join('[^?#]*')}[^?#]*([?#].*)?$`;
  }

  /**
   * Asks Chrome whether it will take a regex, remembering the answers (the
   * rules are rebuilt every minute while an allow list is in force).
   * `isRegexSupported` is chrome.declarativeNetRequest.isRegexSupported.
   */
  function createRegexChecker(isRegexSupported) {
    const known = new Map();
    return async function supported(regex, requireCapturing) {
      // regexFilter must be ASCII; Chrome rejects the whole update otherwise.
      if (!regex || !M.isAscii(regex)) return false;
      const key = (requireCapturing ? '1' : '0') + regex;
      if (known.has(key)) return known.get(key);
      let ok = false;
      try {
        const answer = await isRegexSupported({ regex, isCaseSensitive: false, requireCapturing });
        ok = Boolean(answer && answer.isSupported);
      } catch {
        ok = false;
      }
      if (known.size > 5000) known.clear();
      known.set(key, ok);
      return ok;
    };
  }

  /**
   * The rules for the current state.
   *   state: { blocklist, whitelist, allowOnly (array, or null when no allow
   *            list is in force), immediatelyBlock, now }
   * Returns { dynamic, session, skipped, dropped }: `skipped` entries Chrome
   * would refuse, `dropped` entries that did not fit in the 1000-rule budget.
   */
  async function buildRules(state, { blockedPageBase, supported }) {
    const { blocklist = [], whitelist = [], allowOnly = null, immediatelyBlock = false, now } = state;
    let skipped = 0;
    let dropped = 0;

    const pick = async (regexes, limit, requireCapturing) => {
      const kept = [];
      for (const regex of regexes) {
        if (!regex) continue;
        if (kept.length >= limit) { dropped++; continue; }
        if (await supported(regex, requireCapturing)) kept.push(regex);
        else skipped++;
      }
      return kept;
    };

    // Temporary unblocks: none while "Immediately block" is on.
    const active = immediatelyBlock ? [] : M.readWhitelist(whitelist, now);
    const unblockRegexes = await pick(active.map(unblockRegex), MAX_UNBLOCK_RULES, false);

    // The allow list in force: Focus Bear's own pages, then the user's sites.
    const allowActive = Array.isArray(allowOnly);
    let allowedRegexes = [];
    if (allowActive) {
      const own = await pick(M.ALWAYS_ALLOWED_HOSTS.map(alwaysAllowedRegex), MAX_ALLOW_RULES, false);
      const sites = await pick([...new Set(allowOnly.map(allowRegex))], MAX_ALLOW_RULES - own.length, false);
      allowedRegexes = [...own, ...sites];
    }

    // The block list gets what is left of the budget.
    const reserved = unblockRegexes.length + (allowActive ? allowedRegexes.length + 1 : 0);
    const blockRegexes = await pick([...new Set(blocklist.map(blockRegex))], MAX_REGEX_RULES - reserved, true);

    const dynamic = [];
    let id = 1;
    for (const regexFilter of unblockRegexes) {
      dynamic.push({
        id: id++,
        priority: PRIORITY_UNBLOCK,
        action: { type: 'allow' },
        condition: { regexFilter, isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame', 'sub_frame'] },
      });
    }
    for (const regexFilter of blockRegexes) {
      dynamic.push({
        id: id++,
        priority: PRIORITY_BLOCK,
        action: {
          type: 'redirect',
          // The address goes into the hash: no trouble with "&" in it.
          redirect: { regexSubstitution: `${blockedPageBase}#\\0` },
        },
        condition: { regexFilter, isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame'] },
      });
    }

    const session = [];
    if (allowActive) {
      let sessionId = SESSION_ID_BASE;
      for (const regexFilter of allowedRegexes) {
        session.push({
          id: sessionId++,
          priority: PRIORITY_ALLOWED,
          action: { type: 'allow' },
          condition: { regexFilter, isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame'] },
        });
      }
      session.push({
        id: sessionId++,
        priority: PRIORITY_BLOCK_ALL,
        action: {
          type: 'redirect',
          redirect: { regexSubstitution: `${blockedPageBase}?reason=allow_list#\\0` },
        },
        condition: { regexFilter: '^https?://.*', resourceTypes: ['main_frame'] },
      });
    }

    return { dynamic, session, skipped, dropped };
  }

  const message = (error) => (error && error.message) || String(error);

  /**
   * Installs the rules. `dnr` is chrome.declarativeNetRequest.
   *
   * Whatever fails, no "block every page" rule is left behind:
   *   - allow-list rules an older version kept in the dynamic rules (priority
   *     1 and 2) are removed, also when the block-list update is refused
   *   - when the session rules are refused, the old ones are removed without
   *     adding any, so the allow list is off rather than stuck
   * Returns { dynamicOk, sessionOk }.
   */
  async function applyRules(dnr, plan, log = () => {}) {
    let dynamicOk = true;
    let sessionOk = true;

    const oldDynamic = await dnr.getDynamicRules();
    try {
      await dnr.updateDynamicRules({ removeRuleIds: oldDynamic.map((rule) => rule.id), addRules: plan.dynamic });
    } catch (error) {
      dynamicOk = false;
      log('Block list rules were refused, keeping the previous ones: ' + message(error));
      const legacy = oldDynamic.filter((rule) => !(rule.priority >= PRIORITY_BLOCK)).map((rule) => rule.id);
      if (legacy.length > 0) {
        try {
          await dnr.updateDynamicRules({ removeRuleIds: legacy });
        } catch (legacyError) {
          log('Could not remove the old allow-list rules: ' + message(legacyError));
        }
      }
    }

    if (typeof dnr.updateSessionRules !== 'function') {
      return { dynamicOk, sessionOk: plan.session.length === 0 };
    }
    const oldSession = await dnr.getSessionRules();
    const oldIds = oldSession.map((rule) => rule.id);
    if (oldIds.length === 0 && plan.session.length === 0) return { dynamicOk, sessionOk };
    try {
      await dnr.updateSessionRules({ removeRuleIds: oldIds, addRules: plan.session });
    } catch (error) {
      sessionOk = false;
      log('Allow list rules were refused, switching the allow list rules off: ' + message(error));
      try {
        await dnr.updateSessionRules({ removeRuleIds: oldIds });
      } catch (removeError) {
        log('Could not remove the allow-list rules: ' + message(removeError));
      }
    }
    return { dynamicOk, sessionOk };
  }

  /**
   * Runs tasks one after another. Two rule updates at once read the same old
   * rule ids, and the second is refused for adding an id that already exists.
   */
  function createQueue() {
    let tail = Promise.resolve();
    return function enqueue(task) {
      const run = tail.then(task, task);
      tail = run.catch(() => {});
      return run;
    };
  }

  root.FocusBearDnr = {
    MAX_REGEX_RULES,
    MAX_UNBLOCK_RULES,
    MAX_ALLOW_RULES,
    SESSION_ID_BASE,
    PRIORITY_BLOCK,
    PRIORITY_BLOCK_ALL,
    unblockRegex,
    blockRegex,
    alwaysAllowedRegex,
    allowRegex,
    createRegexChecker,
    buildRules,
    applyRules,
    createQueue,
  };
})(typeof self !== 'undefined' ? self : globalThis);
