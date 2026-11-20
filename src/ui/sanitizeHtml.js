// Note bodies are HTML written by the other Focus Bear apps. Before one is put
// into the editor it is reduced to formatting: scripts, styles, event handlers
// and unknown elements are dropped (the text inside unknown elements is kept).
// Browser only (DOMParser).

const ALLOWED = new Set([
  'P', 'BR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'UL', 'OL', 'LI',
  'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'PRE', 'CODE', 'A', 'IMG', 'INPUT', 'LABEL', 'HR',
]);
const DROPPED = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'TEMPLATE', 'SVG', 'MATH', 'FORM']);
const SAFE_URL = /^(https?:|mailto:)/i;
const SAFE_IMAGE = /^(https:|data:image\/(png|jpeg|gif|webp);base64,)/i;

function clean(node, doc) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) continue; // text
    if (child.nodeType !== 1) {
      child.remove();
      continue;
    }
    const tag = child.tagName.toUpperCase();
    if (DROPPED.has(tag)) {
      child.remove();
      continue;
    }
    clean(child, doc);
    if (!ALLOWED.has(tag)) {
      // keep what is inside
      while (child.firstChild) node.insertBefore(child.firstChild, child);
      child.remove();
      continue;
    }
    for (const attribute of [...child.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      const keep =
        name === 'class' ||
        name.startsWith('data-') ||
        (tag === 'A' && name === 'href' && SAFE_URL.test(value.trim())) ||
        (tag === 'IMG' && name === 'src' && SAFE_IMAGE.test(value.trim())) ||
        (tag === 'IMG' && (name === 'alt' || name === 'width' || name === 'height')) ||
        (tag === 'INPUT' && (name === 'type' || name === 'checked' || name === 'disabled'));
      if (!keep) child.removeAttribute(attribute.name);
    }
    if (tag === 'INPUT' && child.getAttribute('type') !== 'checkbox') child.remove();
    if (tag === 'A') {
      child.setAttribute('target', '_blank');
      child.setAttribute('rel', 'noreferrer');
    }
  }
}

export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${String(html ?? '')}</body>`, 'text/html');
  clean(doc.body, doc);
  return doc.body.innerHTML;
}
