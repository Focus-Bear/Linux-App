// A very small stand-in for the browser's DOM, for the sanitiser's tests only
// (node has no DOMParser and the project takes no dependency for one). It
// builds just enough of a tree for `cleanTree` to walk: elements, text,
// comments, attributes. It is not an HTML parser to rely on anywhere else: the
// app itself always parses with DOMParser (sanitizeHtml.js).

const VOID = new Set(['BR', 'HR', 'IMG', 'INPUT', 'META', 'LINK', 'COL', 'EMBED', 'BASE']);
const RAW_TEXT = new Set(['SCRIPT', 'STYLE']);

class Node {
  constructor(nodeType, parent) {
    this.nodeType = nodeType;
    this.parentNode = parent || null;
    this.childNodes = [];
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  remove() {
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }

  insertBefore(node, reference) {
    if (node.parentNode) node.remove();
    this.childNodes.splice(this.childNodes.indexOf(reference), 0, node);
    node.parentNode = this;
  }

  append(node) {
    this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }
}

class Element extends Node {
  constructor(tagName, parent) {
    super(1, parent);
    this.tagName = tagName;
    this.attributes = [];
  }

  getAttribute(name) {
    const found = this.attributes.find((attribute) => attribute.name === name);
    return found ? found.value : null;
  }

  setAttribute(name, value) {
    const found = this.attributes.find((attribute) => attribute.name === name);
    if (found) found.value = String(value);
    else this.attributes.push({ name, value: String(value) });
  }

  removeAttribute(name) {
    this.attributes = this.attributes.filter((attribute) => attribute.name !== name);
  }
}

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const decode = (text) => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const encode = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Parses `html` into a tree; returns the root (a stand-in for <body>). */
export function parseHtml(html) {
  const root = new Element('BODY', null);
  let open = root;
  const token = /<!--([\s\S]*?)-->|<\/([a-zA-Z][^\s>]*)\s*>|<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+|<)/g;
  let match;
  while ((match = token.exec(html))) {
    const [, comment, closing, opening, attributeText, text] = match;
    if (comment !== undefined) {
      const node = new Node(8, null);
      node.data = comment;
      open.append(node);
    } else if (closing) {
      const tag = closing.toUpperCase();
      for (let at = open; at !== root; at = at.parentNode) {
        if (at.tagName.toUpperCase() === tag) {
          open = at.parentNode;
          break;
        }
      }
    } else if (opening) {
      // SVG elements keep their case in a real HTML document; cleanTree must cope with both.
      const tag = opening.toLowerCase() === 'svg' ? 'svg' : opening.toUpperCase();
      const element = open.append(new Element(tag, null));
      let attribute;
      ATTRIBUTE.lastIndex = 0;
      while ((attribute = ATTRIBUTE.exec(attributeText))) {
        const [, name, double, single, bare] = attribute;
        element.setAttribute(name.toLowerCase(), decode(double ?? single ?? bare ?? ''));
      }
      if (RAW_TEXT.has(tag)) {
        const end = html.toLowerCase().indexOf(`</${tag.toLowerCase()}`, token.lastIndex);
        const stop = end < 0 ? html.length : end;
        const node = new Node(3, null);
        node.data = html.slice(token.lastIndex, stop);
        element.append(node);
        token.lastIndex = stop;
        open = element;
      } else if (!VOID.has(tag) && !/\/\s*$/.test(attributeText)) {
        open = element;
      }
    } else if (text) {
      const node = new Node(3, null);
      node.data = decode(text);
      open.append(node);
    }
  }
  return root;
}

/** The tree as HTML again (what innerHTML would give). */
export function toHtml(node) {
  return node.childNodes
    .map((child) => {
      if (child.nodeType === 3) return encode(child.data);
      if (child.nodeType !== 1) return `<!--${child.data}-->`;
      const tag = child.tagName.toLowerCase();
      const attributes = child.attributes.map(({ name, value }) => ` ${name}="${encode(value).replace(/"/g, '&quot;')}"`).join('');
      return VOID.has(child.tagName) ? `<${tag}${attributes}>` : `<${tag}${attributes}>${toHtml(child)}</${tag}>`;
    })
    .join('');
}
