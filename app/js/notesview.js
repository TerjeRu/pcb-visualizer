// The Notes panel: the board's free notes in a large editor with a formatted preview. The text saves
// while the person types (a second after the last key, and at once on leaving the field), as one
// project/metaUpdated through the controller. Text on the page goes in through value and the Markdown
// renderer, which builds DOM nodes; nothing here writes HTML.

import { createLinkOpener } from './core/links.js';
import { renderMarkdown } from './core/markdown.js';
import { NOTES_LIMIT, bold, checklist, code, counterText, datedEntry, heading, link, list, toggleTask } from './core/notes.js';
import { dom } from './dom.js';

export const SAVE_MS = 1000;
export const SPLIT_MIN_WIDTH = 720;
const FORMATS = { heading, bold, list, checklist, code, link };
const MODES = ['edit', 'split', 'preview'];

export function createNotesView(doc, handlers, timers, options = {}) {
  const { $, el } = dom(doc);
  const now = options.now ?? (() => new Date());
  const text = $('notes-text');
  const preview = $('notes-preview');
  const modeButtons = new Map(MODES.map((mode) => [mode, $(`notes-mode-${mode}`)]));
  const formatButtons = [...doc.querySelectorAll('#panel-notes [data-format]')];

  let choice = null;       // the mode the person picked; null until they pick one
  let width = null;        // the body's width in pixels once it has been measured
  let editable = false;
  let generation = 0;      // raised by reset(), so the answer to a save of the previous board is ignored
  let service = '';        // the newest text the service sent
  let clean = true;        // the field holds no edit of the person's that the service has not got
  let sent = null;         // the text of the save that is under way and not yet seen back
  let failed = false;      // the last save was refused or did not arrive
  let timer = null;
  let drawnPreview = null; // what the preview shows, so a state update that changes nothing leaves it alone

  const wide = () => width !== null && width >= SPLIT_MIN_WIDTH;
  const mode = () => (choice === 'split' && !wide() ? 'edit' : choice ?? (wide() ? 'split' : 'edit'));

  function emptyState() {
    const guided = el('span', 'guide');
    guided.append('No notes yet. Write what you find, or press ', el('strong', '', 'Add dated entry'), ' to start a dated line.');
    const empty = el('p', 'hint');
    empty.append(guided, el('span', 'terse', 'No notes.'));
    return empty;
  }

  /** Draw the preview when it is on screen and what it shows is out of date. */
  function drawPreview() {
    if (preview.hidden) { drawnPreview = null; return; }
    const key = `${editable}:${text.value}`;
    if (key === drawnPreview) return;
    drawnPreview = key;
    if (!text.value.trim()) { preview.replaceChildren(emptyState()); return; }
    preview.replaceChildren(renderMarkdown(doc, text.value, {
      onWikiLink: handlers.onOpenWiki,
      openExternal: createLinkOpener(doc.defaultView),
      onToggleTask: editable ? toggleFromPreview : undefined,
    }));
  }

  function drawLabel() {
    let label = 'Saved';
    if (!clean && text.value !== service) label = failed ? 'Not saved' : 'Saving';
    $('notes-save').textContent = label;
    const counter = counterText(text.value.length);
    $('notes-counter').hidden = !counter;
    $('notes-counter').textContent = counter;
  }

  function drawMode() {
    const current = mode();
    text.hidden = current === 'preview';
    preview.hidden = current === 'edit';
    $('notes-body').dataset.mode = current;
    for (const [name, button] of modeButtons) button.setAttribute('aria-pressed', String(name === current));
    modeButtons.get('split').disabled = !wide();
    modeButtons.get('split').title = wide() ? '' : 'The panel is too narrow for two columns.';
    for (const button of formatButtons) button.disabled = !editable || current === 'preview';
    $('notes-dated').disabled = !editable;
    drawPreview();
  }

  function clearTimer() {
    if (timer !== null) timers.clear(timer);
    timer = null;
  }

  /** Send the text now, unless the service has it or a save of the same text is already on its way. */
  function flush() {
    clearTimer();
    const value = text.value;
    if (clean || value === service || value === sent) return;
    const started = generation;
    sent = value;
    failed = false;
    const lost = () => { if (started === generation && sent === value) { sent = null; failed = true; drawLabel(); } };
    Promise.resolve(handlers.onSaveDetails({ notes: value })).then((ok) => { if (ok === false) lost(); }, lost);
    drawLabel();
  }

  function schedule() {
    clearTimer();
    timer = timers.set(() => { timer = null; flush(); }, SAVE_MS);
  }

  /** The person typed, a button changed the text, or a task was ticked. */
  function changed() {
    clean = text.value === service;
    drawPreview();
    drawLabel();
    schedule();
  }

  function apply(edit) {
    if (text.value.length - (edit.to - edit.from) + edit.text.length > NOTES_LIMIT) return false;
    text.setRangeText(edit.text, edit.from, edit.to, 'end');
    if (edit.select) text.setSelectionRange(edit.select[0], edit.select[1]);
    text.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
    return true;
  }

  function format(name) {
    if (!editable || mode() === 'preview') return;
    apply(FORMATS[name](text.value, text.selectionStart, text.selectionEnd));
    text.focus();
  }

  function addDatedEntry() {
    if (!editable) return;
    if (mode() === 'preview') { choice = wide() ? 'split' : 'edit'; drawMode(); }
    if (!apply(datedEntry(text.value, now()))) return;
    text.focus();
    text.scrollTop = text.scrollHeight;
    flush();
  }

  function toggleFromPreview(index) {
    const edit = toggleTask(text.value, index);
    if (edit && apply(edit)) flush();
  }

  /** After leaving the field: take the service's text if nothing of ours is waiting to be saved. */
  function catchUp() {
    if (clean && text.value !== service) {
      text.value = service;
      drawPreview();
      drawLabel();
    }
  }

  function setWidth(pixels) {
    if (!(pixels > 0)) return;       // a panel that is not on screen has no width to go by
    width = pixels;
    drawMode();
  }

  text.addEventListener('input', () => changed());
  text.addEventListener('blur', () => { flush(); catchUp(); });
  text.addEventListener('scroll', () => {
    if (preview.hidden) return;
    const range = text.scrollHeight - text.clientHeight;
    preview.scrollTop = range > 0 ? (text.scrollTop / range) * (preview.scrollHeight - preview.clientHeight) : 0;
  });
  text.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'b' || key === 'k') {
      event.preventDefault();
      format(key === 'b' ? 'bold' : 'link');
    }
  });
  for (const [name, button] of modeButtons) button.addEventListener('click', () => { choice = name; drawMode(); });
  for (const button of formatButtons) button.addEventListener('click', () => format(button.dataset.format));
  $('notes-dated').addEventListener('click', addDatedEntry);
  const Observer = doc.defaultView?.ResizeObserver;
  if (Observer) new Observer((entries) => setWidth(entries.at(-1)?.contentRect?.width)).observe($('notes-body'));

  drawMode();
  drawLabel();

  return {
    /** The notes the service has, and whether they may be changed. */
    render(notes, canEdit) {
      editable = Boolean(canEdit);
      text.disabled = !editable;
      service = notes;
      if (notes === sent) sent = null;
      if (text.value === notes) clean = true;
      else if (clean && doc.activeElement !== text) text.value = notes;
      drawMode();
      drawLabel();
    },
    /** A different board is on screen: nothing of the old one is kept, and nothing of it is saved. */
    reset() {
      generation += 1;
      clearTimer();
      text.value = '';
      service = '';
      clean = true;
      sent = null;
      failed = false;
      drawMode();
      drawLabel();
    },
    flush,
    focus() { text.focus(); },
    setWidth,
  };
}
