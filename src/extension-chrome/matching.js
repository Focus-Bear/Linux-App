// What counts as blocked, allowed and temporarily unblocked. Shared by the
// Chrome and Firefox extensions: src/extension/matching.js and
// src/extension-chrome/matching.js are the same file (a test checks this; the
// two folders are packaged separately, so neither can import from the other).
//
// No chrome.* / browser.* calls in here, so the rules can be tested with
// `node --test` (src/extension-tests). Loaded as a plain script: by
// importScripts() in the Chrome service worker, from the manifest's
// background scripts in Firefox. Everything is on `FocusBearMatching`.
(function (root) {
  'use strict';

  // The app renews an allow list every minute. It never lasts longer than this
  // without being renewed, whatever expiry was sent or stored.
  const ALLOW_LIST_MAX_MS = 3 * 60 * 1000;
  // The longest "Unblock temporarily" choice on the block page (blocked.html).
  const MAX_UNBLOCK_MS = 90 * 60 * 1000;

  // Never blocked by an allow list: Focus Bear's own pages and what signing in
  // to them needs (Auth0, and Google / Apple for "Continue with ...").
  const ALWAYS_ALLOWED_HOSTS = [
    'focusbear.io', 'auth0.com', 'localhost', '127.0.0.1',
    'accounts.google.com', 'appleid.apple.com',
  ];

  // Keywords that are in nearly every address. Blocking them blocks the web.
  const USELESS_KEYWORDS = ['com', 'www', 'http', 'https'];

  const isAscii = (text) => /^[\x20-\x7E]*$/.test(text);
  const escapeRegex = (text) => text.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');

  // ── Allow list expiry ──────────────────────────────────────────────────────

  /** The expiry to use: never later than 3 minutes from now. */
  function capAllowOnlyUntil(until, now) {
    const value = Number(until);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(value, now + ALLOW_LIST_MAX_MS);
  }

  /** { allowOnly, allowOnlyUntil } from what the app sent or what was stored. */
  function readAllowOnly(value, until, now) {
    const allowOnlyUntil = capAllowOnlyUntil(until, now);
    if (!Array.isArray(value) || now > allowOnlyUntil) return { allowOnly: null, allowOnlyUntil };
    return {
      allowOnly: value.filter((entry) => typeof entry === 'string' && entry.trim()),
      allowOnlyUntil,
    };
  }

  // ── Entries ────────────────────────────────────────────────────────────────

  function normaliseEntry(entry) {
    return String(entry == null ? '' : entry).trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  }

  /**
   * The entry the way a browser writes addresses: an international domain as
   * punycode ("café.fr" becomes "xn--caf-dma.fr"), other characters in the path
   * percent-encoded. '' when it can't be written that way.
   */
  function toAsciiEntry(entry) {
    if (isAscii(entry)) return entry;
    const slash = entry.indexOf('/');
    let host = slash === -1 ? entry : entry.slice(0, slash);
    let path = slash === -1 ? '' : entry.slice(slash);
    try {
      if (!isAscii(host)) host = new URL('http://' + host).hostname;
      if (!isAscii(path)) path = encodeURI(path);
    } catch {
      return '';
    }
    const ascii = (host + path).toLowerCase();
    return isAscii(ascii) ? ascii : '';
  }

  /**
   * An allow-list entry ready for matching: lower case, no scheme, no "www.",
   * nothing from "?" or "#" on, ASCII. '' when there is nothing to match.
   */
  function allowPattern(entry) {
    return toAsciiEntry(normaliseEntry(entry).replace(/[?#].*$/, '').replace(/\/+$/, ''));
  }

  /** { host, path } of a web address ("example.com:8080", "/a/b"), or null. */
  function hostAndPath(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return { host: parsed.host.toLowerCase(), path: parsed.pathname.toLowerCase() };
    } catch {
      return null;
    }
  }

  /**
   * Whether a page is covered by an allow-list entry. The entry is looked for
   * in the host ("wikipedia.org"), or in host + path when it has a "/"
   * ("github.com/focus-bear"); "*" is a wildcard. Never in the query or the
   * fragment: "https://youtube.com/?wikipedia.org" is not Wikipedia.
   */
  function matchesEntry(url, entry) {
    const parts = hostAndPath(url);
    const pattern = allowPattern(entry);
    if (!parts || !pattern) return false;
    const target = pattern.includes('/') ? parts.host + parts.path : parts.host;
    if (!pattern.includes('*')) return target.includes(pattern);
    try {
      return new RegExp(pattern.split('*').map(escapeRegex).join('.*')).test(target);
    } catch {
      return false;
    }
  }

  function isAlwaysAllowed(url) {
    const parts = hostAndPath(url);
    if (!parts) return false;
    const hostname = parts.host.replace(/:\d+$/, '');
    return ALWAYS_ALLOWED_HOSTS.some((host) => hostname === host || hostname.endsWith('.' + host));
  }

  /** True when this page is not on the allow list in force (`allowOnly`: array or null). */
  function isOutsideAllowList(url, allowOnly) {
    if (!Array.isArray(allowOnly) || !hostAndPath(url)) return false;
    if (isAlwaysAllowed(url)) return false;
    return !allowOnly.some((entry) => matchesEntry(url, entry));
  }

  // ── Block list ─────────────────────────────────────────────────────────────

  /** A block-list entry written as a regular expression rather than a site or keyword. */
  function isRegexPattern(pattern) {
    return pattern.includes('.*') || pattern.includes('\\');
  }

  /**
   * A site or keyword from the block list as it is looked for in an address:
   * lower case, no scheme, ASCII. '' for entries that must not block anything
   * (blank, "com", "www", "http", "https").
   */
  function blockText(pattern) {
    const text = String(pattern == null ? '' : pattern).trim().toLowerCase().replace(/^https?:\/\//, '');
    if (!text || USELESS_KEYWORDS.includes(text)) return '';
    if (isAscii(text)) return text;
    // A site: punycode host. A keyword: the way it shows up in a path or search.
    if (text.includes('.')) return toAsciiEntry(text);
    try {
      return encodeURI(text).toLowerCase();
    } catch {
      return '';
    }
  }

  /** The block list prepared once, so each request is only compared, not parsed. */
  function compileBlocklist(list) {
    const compiled = [];
    for (const pattern of Array.isArray(list) ? list : []) {
      if (typeof pattern !== 'string' || !pattern.trim()) continue;
      if (isRegexPattern(pattern)) {
        let regex = null;
        try { regex = new RegExp(pattern, 'i'); } catch { /* matched as plain text below */ }
        compiled.push({ pattern, kind: 'regex', regex, text: pattern.toLowerCase() });
      } else {
        const text = blockText(pattern);
        if (text) compiled.push({ pattern, kind: 'domain', regex: null, text });
      }
    }
    return compiled;
  }

  /** The compiled entry that blocks this address, or null. */
  function findBlocked(url, compiled) {
    const lower = String(url || '').toLowerCase();
    for (const entry of compiled) {
      if (lower.includes(entry.text)) return entry;
      if (entry.regex && entry.regex.test(url)) return entry;
    }
    return null;
  }

  // ── Temporary unblocks ─────────────────────────────────────────────────────

  const stripProtocol = (url) => String(url).replace(/^https?:\/\//, '');

  /**
   * The temporary unblocks worth keeping: well-formed, not expired, and never
   * longer than the block page offers (so a far-future expiry from anywhere
   * else cannot unblock a site for good).
   */
  function readWhitelist(data, now) {
    const entries = [];
    for (const entry of Array.isArray(data) ? data : []) {
      if (!entry || typeof entry.pattern !== 'string' || !entry.pattern) continue;
      if (entry.type !== 'domain' && entry.type !== 'exact') continue;
      const expiresAt = Number(entry.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
      entries.push({ pattern: entry.pattern, type: entry.type, expiresAt: Math.min(expiresAt, now + MAX_UNBLOCK_MS) });
    }
    return entries;
  }

  /** How long an unblock asked for by the block page lasts: 30 minutes unless said, 90 at most. */
  function unblockDuration(durationMs) {
    const value = Number(durationMs);
    if (!Number.isFinite(value) || value <= 0) return 30 * 60 * 1000;
    return Math.min(value, MAX_UNBLOCK_MS);
  }

  function isWhitelisted(url, whitelist, now) {
    for (const entry of whitelist) {
      if (!(entry.expiresAt > now)) continue;
      if (entry.type === 'exact' && stripProtocol(url) === stripProtocol(entry.pattern)) return true;
      if (entry.type === 'domain') {
        try {
          const hostname = new URL(url).hostname;
          if (hostname === entry.pattern || hostname.endsWith('.' + entry.pattern)) return true;
        } catch { /* not an address */ }
      }
    }
    return false;
  }

  root.FocusBearMatching = {
    ALLOW_LIST_MAX_MS,
    MAX_UNBLOCK_MS,
    ALWAYS_ALLOWED_HOSTS,
    USELESS_KEYWORDS,
    isAscii,
    escapeRegex,
    capAllowOnlyUntil,
    readAllowOnly,
    normaliseEntry,
    toAsciiEntry,
    allowPattern,
    hostAndPath,
    matchesEntry,
    isAlwaysAllowed,
    isOutsideAllowList,
    isRegexPattern,
    blockText,
    compileBlocklist,
    findBlocked,
    stripProtocol,
    readWhitelist,
    unblockDuration,
    isWhitelisted,
  };
})(typeof self !== 'undefined' ? self : globalThis);
