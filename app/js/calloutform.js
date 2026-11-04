// The callout form of the Board panel: text, linked wiki page, and the check that clears an AI guess.

import { describeGuess, guessName } from './core/format.js';
import { dom } from './dom.js';

export function createCalloutForm(doc, handlers, s, parts) {
  const { $, options, setValue } = dom(doc);
  let wikiPages = null;            // wiki index for the form, loaded once

  async function ensureWikiPages() {
    if (wikiPages !== null || !handlers.loadWikiIndex) return;
    wikiPages = [];
    try { wikiPages = await handlers.loadWikiIndex(); } catch { wikiPages = []; }
    parts.inspector.draw();
  }

  function remove() {
    const c = s.callout();
    if (!c) return;
    if (doc.defaultView?.confirm && !doc.defaultView.confirm(`Remove the callout${c.text ? ` "${c.text}"` : ''}?`)) return;
    handlers.onRemoveCallout(c.id);
    s.select();
  }

  $('callout-text').addEventListener('change', (event) => { if (s.callout()) handlers.onUpdateCallout(s.calloutId, { text: event.target.value.trim() }); });
  $('callout-wiki').addEventListener('change', (event) => { if (s.callout()) handlers.onUpdateCallout(s.calloutId, { wiki: event.target.value }); });
  $('callout-text').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); event.target.blur(); } });
  $('callout-open').addEventListener('click', (event) => {
    event.preventDefault();
    if (s.callout()?.wiki) handlers.onOpenWiki?.(s.callout().wiki);
  });
  $('callout-delete').addEventListener('click', () => remove());
  $('callout-confirm').addEventListener('click', () => { if (s.callout()) handlers.onUpdateCallout(s.calloutId, { guess: null }); });

  return {
    remove,
    draw(c) {
      ensureWikiPages();
      for (const input of $('callout-form').querySelectorAll('input, select, button')) input.disabled = !s.editable;
      setValue($('callout-text'), c.text);
      const picker = $('callout-wiki');
      const names = (wikiPages ?? []).map((p) => [p.name, p.title]);
      if (c.wiki && !names.some(([n]) => n === c.wiki)) names.push([c.wiki, `${c.wiki} (missing)`]);
      if (doc.activeElement !== picker) {
        options(picker, [['', '(none)'], ...names].map(([value, label]) => ({ value, label })));
        picker.value = c.wiki || '';
      }
      $('callout-open').hidden = !c.wiki;
      $('callout-guess').hidden = !c.guess;
      if (c.guess) $('callout-guess-text').textContent = describeGuess(c.guess, guessName(doc.documentElement.dataset.assistant));
    },
  };
}
