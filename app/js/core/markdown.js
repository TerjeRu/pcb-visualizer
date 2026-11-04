// A small Markdown renderer that builds DOM nodes directly, so text from playbook and wiki files can
// never become HTML: there is no innerHTML anywhere, only createElement and text nodes.
//
// Supported: # headings, paragraphs, "- " and "1. " lists, ``` code blocks, | pipe | tables |,
// **bold**, *italic*, `code`, [links](target) and figures: ![caption](name.svg) or ![caption](name.png)
// alone on a line. options.loadFigure(name) resolves to an image URL (without it, only the caption shows).
// A link to a page name (uart, spi-flash) becomes a
// wiki link handled by `onWikiLink`; an http(s) URL opens in a new tab; anything else (javascript:,
// data:, relative paths) stays plain text. Anything unrecognised stays text.
//
// For text that was not written by the owner (the assistant's replies), options.confirmExternal turns each
// http(s) link into the link text followed by the host in brackets; a click asks for confirmation, showing
// the full address, before anything opens. The address is not in href, so no other gesture opens it.
//
// options.openExternal(href) is set only in the desktop shell (core/links.js), where a plain link does
// nothing: every http(s) link, owner-written or not, then calls it on a click and keeps its address in href.

const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/;
const PAGE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIGURE_RE = /^!\[([^\]]*)\]\(([a-z0-9][a-z0-9-]{0,63}\.(?:svg|png))\)$/;

function inline(doc, parent, text, options) {
  for (const part of String(text).split(INLINE)) {
    if (!part) continue;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      parent.append(makeLink(doc, link[1], link[2], options));
      continue;
    }
    let node = null;
    let inner = part;
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) { node = doc.createElement('strong'); inner = part.slice(2, -2); }
    else if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) { node = doc.createElement('code'); inner = part.slice(1, -1); }
    else if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) { node = doc.createElement('em'); inner = part.slice(1, -1); }
    if (node) { node.textContent = inner; parent.append(node); }
    else parent.append(doc.createTextNode(part));
  }
}

function makeLink(doc, text, target, options) {
  if (PAGE_RE.test(target)) {
    const a = doc.createElement('a');
    a.href = `#wiki/${target}`;
    a.className = 'wiki-link';
    a.dataset.wiki = target;
    a.textContent = text;
    a.addEventListener('click', (event) => { event.preventDefault(); options.onWikiLink?.(target); });
    return a;
  }
  if (/^https?:\/\//i.test(target) && options.confirmExternal) return guardedLink(doc, text, target, options);
  if (/^https?:\/\//i.test(target)) {
    const a = doc.createElement('a');
    a.href = target;
    a.rel = 'noopener noreferrer';
    a.textContent = text;
    if (options.openExternal) a.addEventListener('click', (event) => { event.preventDefault(); options.openExternal(a.href); });
    else a.target = '_blank';
    return a;
  }
  return doc.createTextNode(`${text} (${target})`);
}

function guardedLink(doc, text, target, options) {
  let url;
  try { url = new URL(target); } catch { return doc.createTextNode(`${text} (${target})`); }
  const span = doc.createElement('span');
  const a = doc.createElement('a');
  a.href = '#';
  a.className = 'external-link';
  a.textContent = text;
  a.addEventListener('click', (event) => {
    event.preventDefault();
    options.confirmExternal(url.href);
  });
  const host = doc.createElement('span');
  host.className = 'link-host';
  host.textContent = ` [${url.host}]`;
  span.append(a, host);
  return span;
}

function makeFigure(doc, caption, file, options) {
  const figure = doc.createElement('figure');
  figure.className = 'md-figure';
  if (options.loadFigure) {
    const img = doc.createElement('img');
    img.alt = caption;
    figure.append(img);
    new Promise((resolve) => resolve(options.loadFigure(file))).then((url) => { if (url) img.src = url; else img.remove(); }, () => img.remove());
  }
  const figcaption = doc.createElement('figcaption');
  figcaption.textContent = caption;
  figure.append(figcaption);
  return figure;
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isTableRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/** Render Markdown text into a DocumentFragment. options.onWikiLink(name) handles page links, options.loadFigure(file) figures. */
export function renderMarkdown(doc, text, options = {}) {
  const fragment = doc.createDocumentFragment();
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let paragraph = [];
  let listEl = null;
  let item = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = doc.createElement('p');
    inline(doc, p, paragraph.join(' '), options);
    fragment.append(p);
    paragraph = [];
  };
  const closeList = () => { listEl = null; item = null; };
  const closeAll = () => { flushParagraph(); closeList(); };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    if (/^```/.test(line)) {                       // fenced code block, kept verbatim
      closeAll();
      const body = [];
      for (i += 1; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = body.join('\n');
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    const figure = FIGURE_RE.exec(line.trim());
    if (figure) {
      closeAll();
      fragment.append(makeFigure(doc, figure[1], figure[2], options));
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeAll();
      const h = doc.createElement(`h${Math.min(heading[1].length + 1, 5)}`);   // page title is h2 in the panel
      inline(doc, h, heading[2], options);
      fragment.append(h);
      continue;
    }

    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      closeAll();
      const table = doc.createElement('table');
      const head = doc.createElement('tr');
      for (const cell of cells(line)) {
        const th = doc.createElement('th');
        inline(doc, th, cell, options);
        head.append(th);
      }
      const thead = doc.createElement('thead');
      thead.append(head);
      const tbody = doc.createElement('tbody');
      for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
        const row = doc.createElement('tr');
        for (const cell of cells(lines[i])) {
          const td = doc.createElement('td');
          inline(doc, td, cell, options);
          row.append(td);
        }
        tbody.append(row);
      }
      i -= 1;
      table.append(thead, tbody);
      fragment.append(table);
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const tag = numbered ? 'OL' : 'UL';
      if (!listEl || listEl.tagName !== tag) {
        listEl = doc.createElement(tag.toLowerCase());
        fragment.append(listEl);
      }
      item = doc.createElement('li');
      inline(doc, item, (numbered ?? bullet)[1], options);
      listEl.append(item);
    } else if (line.trim() === '') {
      closeAll();
    } else if (item && /^\s+/.test(raw)) {
      item.append(doc.createTextNode(' '));        // an indented line continues the list item
      inline(doc, item, line.trim(), options);
    } else {
      closeList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  return fragment;
}
