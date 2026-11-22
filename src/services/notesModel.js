// Notes / Brain Dump model: request bodies and list helpers. The calls are the
// Windows app's (API/FocusBearAPIClient.Notes.cs, Core/Notes/PersonalNotes.cs):
//
//   GET    /note?page=&take=10&order=DESC          { data: [note], meta: { hasNextPage } }
//   GET    /note?page=1&take=50&pinned=true        pinned notes
//   GET    /note/search?query=&take=20             [note]
//   PUT    /note                                   create (no id) or update; only the keys sent are changed
//   DELETE /note?note_id=                          (404 = already gone)
//
// The brain dump is the one note with is_brain_dump = true.
//
// Pure functions only (no React, no fetch), covered by node --test.

export const MAX_TITLE = 500;
export const MAX_BODY = 50000;
export const PAGE_SIZE = 10;
export const BRAIN_DUMP_TITLE = 'Brain Dump';
/** Local id of the brain dump row before the account has one. */
export const BRAIN_DUMP_PLACEHOLDER_ID = 'brain-dump-placeholder';

/** Prefix of the id a new note has until the server gives it one. */
export const DRAFT_PREFIX = 'draft-';

/** True for ids made in this app (a new note, the brain dump placeholder): the server doesn't know them. */
export function isLocalNoteId(id) {
  return !id || id === BRAIN_DUMP_PLACEHOLDER_ID || String(id).startsWith(DRAFT_PREFIX);
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Plain text of a note body (HTML), for the list preview. */
export function plainText(html) {
  return String(html ?? '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity])
    .replace(/\s+/g, ' ')
    .trim();
}

export function preview(note, max = 90) {
  const text = plainText(note?.body);
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Text typed into a plain field, as the HTML the notes are stored in. */
export function textToHtml(text) {
  const escaped = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .split(/\n/)
    .map((line) => `<p>${line || '<br>'}</p>`)
    .join('');
}

export function isBrainDump(note) {
  return Boolean(note) && note.is_brain_dump === true;
}

export function isPinned(note) {
  return Boolean(note) && Boolean(note.pinned_at);
}

/** When the note was written: logged_at, else created_at (epoch ms; 0 when unknown). */
export function noteTime(note) {
  const time = Date.parse(note?.logged_at || note?.created_at || '');
  return Number.isFinite(time) ? time : 0;
}

/** "21 Nov 2026" for the list. */
export function noteDate(note, locale = 'en-GB', timeZone) {
  const time = noteTime(note);
  if (!time) return '';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(time);
}

/** When the note was last saved: updated_at, else created_at (epoch ms; 0 when unknown). */
export function updatedTime(note) {
  const time = Date.parse(note?.updated_at || note?.created_at || '');
  return Number.isFinite(time) ? time : 0;
}

/**
 * The brain dump to use among `notes`, or null. The server does not keep one
 * per account, so an account can have several (another app missed the old one
 * and made a new one): the most recently updated is the one in use, as on
 * Windows (Core/Notes/PersonalNotes.cs, BrainDumpTracker).
 */
export function latestBrainDump(notes) {
  let latest = null;
  for (const note of Array.isArray(notes) ? notes : []) {
    if (isBrainDump(note) && (!latest || updatedTime(note) > updatedTime(latest))) latest = note;
  }
  return latest;
}

/** Shown when text can't be added to a note that is at the server's limit. */
export const BRAIN_DUMP_FULL = 'Your Brain Dump is full. Open it under Notes and clear some text, then try again.';

/**
 * The list as shown: the brain dump first (a placeholder row when the account
 * has none yet), then pinned notes, then the rest, newest first. A note that
 * came back from two calls (pinned and paged) appears once.
 */
export function arrangeNotes(notes, { withBrainDump = true } = {}) {
  const seen = new Set();
  const unique = [];
  for (const note of Array.isArray(notes) ? notes : []) {
    if (!note || !note.id || seen.has(note.id)) continue;
    seen.add(note.id);
    unique.push(note);
  }
  const rank = (note) => (isBrainDump(note) ? 0 : isPinned(note) ? 1 : 2);
  // An account can carry several brain dumps (see latestBrainDump): the one in use is on top.
  const newest = (a, b) => (isBrainDump(a) && isBrainDump(b) ? updatedTime(b) - updatedTime(a) : 0) || noteTime(b) - noteTime(a);
  unique.sort((a, b) => rank(a) - rank(b) || newest(a, b));
  if (withBrainDump && !unique.some(isBrainDump)) {
    unique.unshift({ id: BRAIN_DUMP_PLACEHOLDER_ID, title: BRAIN_DUMP_TITLE, body: '', is_brain_dump: true, tags: [] });
  }
  return unique;
}

/** Why a note can't be saved, or null. */
export function noteError(title, body) {
  if (!String(title ?? '').trim()) return 'Give the note a title.';
  if (String(title).trim().length > MAX_TITLE) return `The title can have up to ${MAX_TITLE} characters.`;
  if (String(body ?? '').length > MAX_BODY) return 'This note is too long to save.';
  return null;
}

/**
 * Body of PUT /note. A note without a server id is created; the brain dump is
 * flagged as such (the server does not check that there is only one: see
 * `findBrainDump` in toolsApiCore.js). The text is sent whole: a body over
 * MAX_BODY is refused by the server, and callers check with `noteError` first,
 * so nothing is ever cut off the end without the user knowing.
 */
export function noteBody(note, { title, body }) {
  const out = { title: String(title ?? '').trim().slice(0, MAX_TITLE), body: String(body ?? '') };
  if (!isLocalNoteId(note?.id)) out.id = note.id;
  if (isBrainDump(note)) out.is_brain_dump = true;
  return out;
}

/** Body of PUT /note that pins or unpins. */
export function pinBody(note, pinned) {
  return { id: note.id, pinned: Boolean(pinned) };
}
