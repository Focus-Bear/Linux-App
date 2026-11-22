// What a note body may contain when it is put into the editor, and the pass
// that enforces it. No DOM globals here: `cleanTree` works on anything shaped
// like a DOM node (childNodes, attributes, remove, insertBefore…), so the same
// code runs on a DOMParser document in the window (sanitizeHtml.js) and on a
// small stand-in under node --test (sanitizeHtmlCore.test.js).
//
// Two kinds of thing are taken out:
//   - dangerous content (scripts, frames, SVG / MathML, forms, event handlers,
//     javascript: and data: URLs). Removed without a word.
//   - formatting this editor can't keep (an element or attribute outside the
//     lists below). Removed as well, but reported in `lost`: the Notes page
//     opens such a note read-only, so saving from here never destroys it.

export const ALLOWED = new Set([
  'P', 'BR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'UL', 'OL', 'LI',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'CODE', 'A', 'IMG', 'INPUT', 'LABEL', 'HR',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'COLGROUP', 'COL',
  'FIGURE', 'FIGCAPTION', 'MARK', 'SUB', 'SUP',
]);

/** Removed with everything inside. */
export const DROPPED = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'TEMPLATE', 'SVG', 'MATH', 'FORM']);

const SAFE_URL = /^(https?:|mailto:)/i;
const SAFE_IMAGE = /^(https:|data:image\/(png|jpeg|gif|webp);base64,)/i;
// A URL that can run code or carry a document. Browsers skip whitespace and
// control characters inside the scheme, so they are taken out before the test.
const DANGEROUS_URL = /^(javascript|vbscript|data):/i;
// eslint-disable-next-line no-control-regex
const isDangerousUrl = (value) => DANGEROUS_URL.test(String(value).replace(/[\u0000- \u007f-\u009f]/g, ''));

// --- inline style ---------------------------------------------------------------
// Only these properties, and only values that match: no url(), no var(), no
// expressions, nothing that can move or cover other parts of the window.

const LENGTH = /^(0|\d{1,4}(\.\d{1,3})?(px|pt|em|rem|%))$/;
const COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,30}|(rgb|rgba|hsl|hsla)\(\s*[\d.]+(deg)?%?(\s*[,\s/]\s*[\d.]+%?){2,3}\s*\))$/;
const oneOf = (...words) => new RegExp(`^(${words.join('|')})$`);
const STYLE_VALUES = {
  color: COLOR,
  'background-color': COLOR,
  'text-align': oneOf('left', 'right', 'center', 'justify', 'start', 'end'),
  'font-weight': oneOf('normal', 'bold', 'bolder', 'lighter', '[1-9]00'),
  'font-style': oneOf('normal', 'italic', 'oblique'),
  'font-size': new RegExp(`${LENGTH.source}|^(xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$`),
  'font-family': /^[a-z0-9 ,'"_-]{1,200}$/,
  'text-decoration': /^(none|underline|line-through|overline)( (underline|line-through|overline))*$/,
  'text-decoration-line': /^(none|underline|line-through|overline)( (underline|line-through|overline))*$/,
  'vertical-align': oneOf('top', 'middle', 'bottom', 'baseline', 'sub', 'super'),
  'white-space': oneOf('normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'),
  'line-height': new RegExp(`${LENGTH.source}|^(normal|\\d(\\.\\d{1,2})?)$`),
  'list-style-type': /^[a-z-]{1,30}$/,
  width: new RegExp(`${LENGTH.source}|^auto$`),
  height: new RegExp(`${LENGTH.source}|^auto$`),
  'margin-left': LENGTH,
  'margin-right': LENGTH,
  'padding-left': LENGTH,
  'padding-right': LENGTH,
  'text-indent': LENGTH,
};

/**
 * A style attribute reduced to the declarations above.
 * { style: 'color: red; text-align: center', lost: ['style: position'] }
 */
export function cleanStyle(text) {
  const kept = [];
  const lost = [];
  for (const part of String(text ?? '').split(';')) {
    if (!part.trim()) continue;
    const colon = part.indexOf(':');
    const property = (colon < 0 ? part : part.slice(0, colon)).trim().toLowerCase();
    const value = (colon < 0 ? '' : part.slice(colon + 1))
      .replace(/!\s*important\s*$/i, '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
    const rule = Object.prototype.hasOwnProperty.call(STYLE_VALUES, property) ? STYLE_VALUES[property] : null;
    if (rule && rule.test(value)) kept.push(`${property}: ${value}`);
    else lost.push(`style: ${/^[a-z-]{1,40}$/.test(property) ? property : '?'}`);
  }
  return { style: kept.join('; '), lost };
}

// --- attributes -------------------------------------------------------------------

// Taken off without counting as lost formatting: they change nothing a reader sees.
const QUIET = new Set(['id', 'name', 'contenteditable', 'spellcheck', 'tabindex', 'role', 'draggable', 'translate', 'target', 'rel']);
const NUMBER = /^\d{1,4}$/;

/**
 * What happens to one attribute:
 *   { keep: true, value }   stays (value may have been reduced)
 *   { keep: false }         removed: dangerous, or of no consequence
 *   { keep: false, lost }   removed, and the note loses formatting by it
 */
export function attributeVerdict(tag, rawName, rawValue) {
  const name = String(rawName).toLowerCase();
  const value = String(rawValue ?? '');
  const trimmed = value.trim();
  const keep = { keep: true, value };
  const lost = { keep: false, lost: `${tag.toLowerCase()} ${name}` };
  if (name.startsWith('on')) return { keep: false }; // event handler
  if (name === 'class' || name.startsWith('data-') || name === 'title') return keep;
  if (QUIET.has(name) || name.startsWith('aria-')) return { keep: false };
  if (name === 'style') {
    const cleaned = cleanStyle(value);
    if (cleaned.style) return { keep: true, value: cleaned.style, lost: cleaned.lost[0] };
    return { keep: false, lost: cleaned.lost[0] };
  }
  if (name === 'dir') return /^(ltr|rtl|auto)$/i.test(trimmed) ? keep : lost;
  if (name === 'lang') return /^[a-z0-9-]{1,20}$/i.test(trimmed) ? keep : lost;
  if (tag === 'A' && name === 'href') {
    if (SAFE_URL.test(trimmed)) return keep;
    return isDangerousUrl(value) ? { keep: false } : lost;
  }
  if (tag === 'IMG' && name === 'src') {
    if (SAFE_IMAGE.test(trimmed)) return keep;
    return isDangerousUrl(value) ? { keep: false } : lost;
  }
  if (tag === 'IMG' && (name === 'alt' || name === 'width' || name === 'height')) return keep;
  if (tag === 'INPUT' && (name === 'type' || name === 'checked' || name === 'disabled')) return keep;
  if (tag === 'INPUT') return { keep: false }; // a tick box has nothing else worth keeping
  if ((tag === 'TD' || tag === 'TH') && (name === 'colspan' || name === 'rowspan')) return NUMBER.test(trimmed) ? keep : lost;
  if (tag === 'TH' && name === 'scope') return /^(row|col|rowgroup|colgroup)$/i.test(trimmed) ? keep : lost;
  if ((tag === 'COL' || tag === 'COLGROUP') && name === 'span') return NUMBER.test(trimmed) ? keep : lost;
  if (tag === 'OL' && name === 'start') return /^-?\d{1,6}$/.test(trimmed) ? keep : lost;
  if (tag === 'OL' && name === 'reversed') return keep;
  if (tag === 'OL' && name === 'type') return /^[1aAiI]$/.test(trimmed) ? keep : lost;
  return lost;
}

// --- the pass ---------------------------------------------------------------------

/**
 * Cleans everything under `root` in place. Returns what formatting was taken
 * out, e.g. ['<font>', 'td align', 'style: position']; empty when the note
 * can be edited and saved without losing anything it had.
 */
export function cleanTree(root) {
  const lost = new Set();
  const visit = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) continue; // text
      if (child.nodeType !== 1) {
        child.remove(); // comments and the like
        continue;
      }
      const tag = String(child.tagName).toUpperCase();
      if (DROPPED.has(tag)) {
        child.remove();
        continue;
      }
      visit(child);
      if (!ALLOWED.has(tag)) {
        // keep what is inside
        lost.add(`<${tag.toLowerCase()}>`);
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }
      if (tag === 'INPUT' && String(child.getAttribute('type') || '').toLowerCase() !== 'checkbox') {
        child.remove(); // only tick boxes; any other field is a form control
        continue;
      }
      for (const attribute of [...child.attributes]) {
        const verdict = attributeVerdict(tag, attribute.name, attribute.value);
        if (verdict.lost) lost.add(verdict.lost);
        if (!verdict.keep) child.removeAttribute(attribute.name);
        else if (verdict.value !== attribute.value) child.setAttribute(attribute.name, verdict.value);
      }
      if (tag === 'A') {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noreferrer');
      }
    }
  };
  visit(root);
  return [...lost];
}
