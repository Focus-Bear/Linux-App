// Note bodies are HTML written by the other Focus Bear apps. Before one is put
// into the editor it is reduced to formatting: scripts, styles, event handlers
// and unknown elements are dropped (the text inside unknown elements is kept).
// The rules and the pass itself are in sanitizeHtmlCore.js (tested under node);
// this file only supplies the browser's parser (DOMParser, an inert document:
// nothing in it runs or loads).
import { cleanTree } from './sanitizeHtmlCore.js';

/**
 * { html, lost }: the cleaned HTML, and the formatting that had to be taken
 * out to get there (empty when nothing a reader would miss was removed).
 */
export function inspectHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${String(html ?? '')}</body>`, 'text/html');
  const lost = cleanTree(doc.body);
  return { html: doc.body.innerHTML, lost };
}

export function sanitizeHtml(html) {
  return inspectHtml(html).html;
}
