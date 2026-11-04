// The Wiki tab: an index of pages and one page at a time. Pages come from the service (built-in starter
// pages, replaced or extended by ~/hw/wiki), grouped by the sections the service sends, and are rendered
// with core/markdown.js, which never produces HTML. Links between pages stay inside this tab.

import { createLinkOpener } from './core/links.js';
import { renderMarkdown } from './core/markdown.js';
import { dom } from './dom.js';

export function createWikiView(doc, handlers) {
  const { $ } = dom(doc);
  let current = null;            // page name on screen, null for the index
  let request = 0;               // ignore answers to requests that were overtaken by a newer click

  $('wiki-index-button').addEventListener('click', () => showIndex());

  function status(text) {
    $('wiki-status').hidden = !text;
    $('wiki-status').textContent = text ?? '';
  }

  function pageItem(page) {
    const item = doc.createElement('li');
    const link = doc.createElement('a');
    link.href = `#wiki/${page.name}`;
    link.className = 'wiki-link';
    link.textContent = page.title;
    link.addEventListener('click', (event) => { event.preventDefault(); open(page.name); });
    item.append(link);
    if (page.origin === 'data repo') {
      const mark = doc.createElement('span');
      mark.className = 'origin';
      mark.textContent = 'yours';
      mark.title = 'From ~/hw/wiki';
      item.append(' ', mark);
    }
    return item;
  }

  async function showIndex() {
    const mine = ++request;
    current = null;
    $('wiki-page').hidden = true;
    $('wiki-index').hidden = false;
    $('wiki-index-button').disabled = true;
    status('The app loads the pages.');
    try {
      const pages = await handlers.loadWikiIndex();
      if (mine !== request) return;
      status(pages.length ? '' : 'No wiki pages found.');
      const sections = new Map();
      for (const page of pages) {
        if (!sections.has(page.section)) sections.set(page.section, []);
        sections.get(page.section).push(page);
      }
      $('wiki-index').replaceChildren(...[...sections].map(([title, members]) => {
        const section = doc.createElement('li');
        section.className = 'wiki-section';
        const heading = doc.createElement('h3');
        heading.textContent = title ?? 'Pages';
        const list = doc.createElement('ul');
        list.append(...members.map(pageItem));
        section.append(heading, list);
        return section;
      }));
    } catch (error) {
      if (mine === request) status(`Could not load the wiki: ${error.message}`);
    }
  }

  /** A line above the Start here page that starts or resumes the tutorial. Not drawn for a finished one, or where it cannot start. */
  function tutorialLine() {
    const info = handlers.tutorialInfo?.();
    if (!info || info.active || info.canStart === false || !['new', 'skipped', 'started'].includes(info.state)) return [];
    const started = info.state === 'started';
    const line = doc.createElement('p');
    const link = doc.createElement('a');
    link.href = '#tutorial';
    link.dataset.tutorial = started ? 'resume' : 'start';
    link.textContent = started ? `Resume the tutorial (step ${info.step} of 18)` : 'Take the guided tutorial';
    link.addEventListener('click', (event) => { event.preventDefault(); handlers.startTutorial?.({ resume: started }); });
    line.append(link, started ? '.' : '. Find the UART on a practice board. It takes about 20 minutes and needs no hardware.');
    return [line];
  }

  async function open(name) {
    const mine = ++request;
    current = name;
    $('wiki-index').hidden = true;
    $('wiki-index-button').disabled = false;
    status('The app loads the page.');
    try {
      const page = await handlers.loadWikiPage(name);
      if (mine !== request) return;
      status('');
      const body = $('wiki-page');
      body.hidden = false;
      body.replaceChildren(...(name === 'start-here' ? tutorialLine() : []), renderMarkdown(doc, page.markdown, { onWikiLink: open, loadFigure: handlers.loadWikiFigure, openExternal: createLinkOpener(doc.defaultView) }));
      $('wiki-source').textContent = page.origin === 'data repo' ? `~/hw/wiki/${name}.md` : `This is a built-in page. To edit it, copy it to ~/hw/wiki/${name}.md.`;
      $('tab-wiki').scrollIntoView?.({ block: 'start' });
    } catch (error) {
      if (mine !== request) return;
      $('wiki-page').hidden = true;
      $('wiki-source').textContent = '';
      status(error.status === 404 ? `There is no page called "${name}" yet. Create ~/hw/wiki/${name}.md to add one.` : `Could not load the page: ${error.message}`);
    }
  }

  return {
    open,
    showIndex,
    /** Show the index the first time the tab is opened without a page. */
    ensure() { if (current === null) showIndex(); },
  };
}
