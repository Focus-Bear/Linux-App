import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeVerdict, cleanStyle, cleanTree } from './sanitizeHtmlCore.js';
import { parseHtml, toHtml } from './sanitizeHtmlTestDom.js';

/** What sanitizeHtml.js does in the window, on the stand-in tree. */
function inspect(html) {
  const root = parseHtml(html);
  const lost = cleanTree(root);
  return { html: toHtml(root), lost };
}

test('what the web editor and the other apps write is kept as it is', () => {
  const bodies = [
    '<p>Plain <strong>bold</strong> <em>italic</em> <u>under</u> <s>struck</s></p>',
    '<h1>a</h1><h2>b</h2><h3>c</h3><h4>d</h4><h5>e</h5><h6>f</h6>',
    '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol start="3"><li>three</li></ol>',
    '<blockquote><p>quote</p></blockquote><pre><code class="language-js">x &lt; 1</code></pre><hr>',
    '<p>H<sub>2</sub>O, x<sup>2</sup>, <mark class="marker-yellow">highlight</mark></p>',
    '<figure class="image"><img src="https://example.com/a.png" alt="A"><figcaption>Caption</figcaption></figure>',
    '<figure class="table"><table><thead><tr><th colspan="2" scope="col">Head</th></tr></thead><tbody><tr><td rowspan="2">a</td><td>b</td></tr></tbody></table></figure>',
    '<table><caption>T</caption><colgroup><col span="2" style="width: 40%"></colgroup><tfoot><tr><td>f</td></tr></tfoot></table>',
    '<p style="text-align: center"><span style="color: hsl(0, 75%, 60%); background-color: #fff3a1">coloured</span></p>',
    '<p dir="rtl" lang="ar" title="note">x</p>',
  ];
  for (const body of bodies) {
    const { html, lost } = inspect(body);
    assert.deepEqual(lost, [], body);
    assert.equal(html, body);
  }
});

test('a table and a highlight survive: this is the note the review lost', () => {
  const body = '<table><tbody><tr><td>cell</td></tr></tbody></table><p><mark>important</mark></p>';
  assert.deepEqual(inspect(body), { html: body, lost: [] });
});

test('formatting the editor cannot keep is reported, so the note opens read-only', () => {
  assert.deepEqual(inspect('<p><font face="Arial">old</font></p>'), { html: '<p>old</p>', lost: ['<font>'] });
  assert.deepEqual(inspect('<details><summary>More</summary>text</details>').lost, ['<summary>', '<details>']);
  assert.deepEqual(inspect('<td align="center">x</td>').lost, ['td align']);
  assert.deepEqual(inspect('<p style="color: red; position: fixed">x</p>'), { html: '<p style="color: red">x</p>', lost: ['style: position'] });
  assert.deepEqual(inspect('<p style="float: left">x</p>'), { html: '<p>x</p>', lost: ['style: float'] });
  assert.deepEqual(inspect('<a href="/relative">x</a>').lost, ['a href']);
  assert.deepEqual(inspect('<img src="http://example.com/a.png">').lost, ['img src']);
  assert.deepEqual(inspect('<td colspan="2;x">x</td>').lost, ['td colspan']);
  assert.deepEqual(inspect('<video controls></video>').lost, ['<video>']);
});

test('dangerous content is removed without making the note read-only', () => {
  const gone = (body, expected) => assert.deepEqual(inspect(body), { html: expected, lost: [] }, body);
  gone('<p>a</p><script>alert(1)</script>', '<p>a</p>');
  gone('<style>p { color: red }</style><p>a</p>', '<p>a</p>');
  gone('<iframe src="https://example.com"></iframe><p>a</p>', '<p>a</p>');
  gone('<object data="x"></object><embed src="x"><p>a</p>', '<p>a</p>');
  gone('<svg onload="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)">x</a></svg><p>a</p>', '<p>a</p>');
  gone('<math><mi>x</mi></math><p>a</p>', '<p>a</p>');
  gone('<form action="https://example.com"><input type="text" name="q"><p>inside</p></form><p>a</p>', '<p>a</p>');
  gone('<link rel="stylesheet" href="x"><meta http-equiv="refresh" content="0"><template><p>t</p></template><p>a</p>', '<p>a</p>');
  gone('<p onclick="alert(1)" ONMOUSEOVER="alert(2)">a</p>', '<p>a</p>');
  gone('<img src="https://example.com/a.png" onerror="alert(1)">', '<img src="https://example.com/a.png">');
  gone('<a href="javascript:alert(1)">x</a>', '<a target="_blank" rel="noreferrer">x</a>');
  gone('<a href=" jAvA\tsCript:alert(1)">x</a>', '<a target="_blank" rel="noreferrer">x</a>');
  gone('<a href="data:text/html,<script>alert(1)</script>">x</a>', '<a target="_blank" rel="noreferrer">x</a>');
  gone('<a href="vbscript:x">x</a>', '<a target="_blank" rel="noreferrer">x</a>');
  gone('<img src="data:image/svg+xml;base64,PHN2Zz4=">', '<img>');
  gone('<img src="javascript:alert(1)">', '<img>');
  gone('<p>a<!-- comment --></p>', '<p>a</p>');
  gone('<input type="text" value="x"><input type="checkbox" checked>', '<input type="checkbox" checked="">');
  gone('<p id="app" contenteditable="true" tabindex="0" aria-label="x">a</p>', '<p>a</p>');
});

test('scripts and handlers inside elements that are unwrapped are still removed', () => {
  const { html } = inspect('<section onclick="alert(1)"><p onclick="alert(2)">a<script>alert(3)</script></p><iframe></iframe></section>');
  assert.equal(html, '<p>a</p>');
  const nested = inspect('<table><tr><td onclick="x" style="background-color: red; background-image: url(https://example.com/t.gif)"><svg></svg>c</td></tr></table>');
  assert.equal(nested.html, '<table><tr><td style="background-color: red">c</td></tr></table>');
});

test('nothing dangerous is left in any attribute after the pass', () => {
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '<a href="JaVaScRiPt:alert(1)" onfocus=alert(1) autofocus>x</a>',
    '<table background="javascript:alert(1)"><td onmouseenter=alert(1)>x</td></table>',
    '<mark style="background:url(javascript:alert(1))" onclick=alert(1)>x</mark>',
    '<figure onpointerdown=alert(1)><figcaption style="expression(alert(1))">x</figcaption></figure>',
    '<div style="position:fixed;top:0;left:0;width:100%;height:100%" data-x="1">cover</div>',
    '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
    '<p style="color: red; background-color: url(https://example.com/x)">x</p>',
    '<p style="width: expression(alert(1)); font-family: x; } body { display: none">x</p>',
  ];
  for (const payload of payloads) {
    const { html } = inspect(payload);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, payload);
    assert.doesNotMatch(html, /javascript:|expression|url\(|position|<script|<svg|<iframe/i, payload);
  }
});

test('a links open outside the app', () => {
  assert.equal(inspect('<a href="https://focusbear.io" target="_self" rel="opener">x</a>').html, '<a href="https://focusbear.io" target="_blank" rel="noreferrer">x</a>');
  assert.deepEqual(inspect('<a href="mailto:a@example.com">x</a>').lost, []);
});

test('style: only known properties with plain values are kept', () => {
  assert.deepEqual(cleanStyle('COLOR: Red ; text-align:center;'), { style: 'color: red; text-align: center', lost: [] });
  assert.deepEqual(cleanStyle('color: rgb(255, 0, 0) !important'), { style: 'color: rgb(255, 0, 0)', lost: [] });
  assert.deepEqual(cleanStyle('background-color: rgba(0 0 0 / 0.5); font-size: 14px; width: 50%'), {
    style: 'background-color: rgba(0 0 0 / 0.5); font-size: 14px; width: 50%',
    lost: [],
  });
  for (const bad of [
    'color: url(https://example.com/x)',
    'color: var(--fb-text)',
    'background-color: expression(alert(1))',
    'background: red',
    'background-image: url(x)',
    'position: absolute',
    'margin-left: -9999px',
    'width: calc(100% + 500px)',
    'font-size: 99999px',
    'font-family: x\\3b }',
    'text-align: center/**/',
    'display: none',
    'z-index: 99',
    '-moz-binding: url(x)',
    'color',
  ]) {
    const { style, lost } = cleanStyle(bad);
    assert.equal(style, '', bad);
    assert.equal(lost.length, 1, bad);
  }
});

test('attributes: kept, dropped quietly, or dropped as lost formatting', () => {
  assert.deepEqual(attributeVerdict('TD', 'colspan', '3'), { keep: true, value: '3' });
  assert.deepEqual(attributeVerdict('P', 'colspan', '3'), { keep: false, lost: 'p colspan' });
  assert.deepEqual(attributeVerdict('P', 'onclick', 'x'), { keep: false });
  assert.deepEqual(attributeVerdict('P', 'ONLOAD', 'x'), { keep: false });
  assert.deepEqual(attributeVerdict('P', 'id', 'x'), { keep: false });
  assert.deepEqual(attributeVerdict('IMG', 'src', 'https://example.com/a.png'), { keep: true, value: 'https://example.com/a.png' });
  assert.deepEqual(attributeVerdict('P', 'src', 'https://example.com/a.png'), { keep: false, lost: 'p src' });
  assert.deepEqual(attributeVerdict('A', 'href', 'java\nscript:alert(1)'), { keep: false });
  assert.deepEqual(attributeVerdict('P', 'style', 'color: red; top: 0'), { keep: true, value: 'color: red', lost: 'style: top' });
  assert.deepEqual(attributeVerdict('P', 'style', 'top: 0'), { keep: false, lost: 'style: top' });
});

test('cleaning is stable: what was cleaned once is not changed or reported again', () => {
  const first = inspect('<div style="color: red; top: 0"><font>a</font><table border="1"><tr><td>b</td></tr></table></div>');
  assert.ok(first.lost.length > 0);
  assert.deepEqual(inspect(first.html), { html: first.html, lost: [] });
});
