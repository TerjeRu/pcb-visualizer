// The menu on the status chip: Undo and Redo, where the board is stored, a way to open that folder, and
// with git on the time of the last commit. The keys follow the Panels menu in dock.js. Ctrl+Z, Ctrl+Shift+Z
// and Ctrl+Y do what the Undo and Redo items do, except in a text field, which has its own undo.

import { dom } from './dom.js';
import { shortText } from './core/format.js';
import { commitTime } from './viewmodel.js';

// Fields with a text undo of their own. A checkbox or a select has none, so Ctrl+Z there undoes the board change.
const OWN_UNDO = 'input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="button"], [type="submit"], [type="reset"], [type="file"]), textarea, [contenteditable]:not([contenteditable="false"])';

/** 'undo', 'redo' or null for a key press. */
function historyKey(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  return key === 'y' && !event.shiftKey ? 'redo' : null;
}

export function createStatusMenu(doc, handlers) {
  const { $, el } = dom(doc);
  const button = $('status-button');
  let menu = null;
  let generation = 0;                 // bumped on close, so a late answer never fills a menu that is gone

  function close({ refocus = false } = {}) {
    generation += 1;
    menu?.remove();
    menu = null;
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  }

  function item(label, run) {
    const node = el('button', '', label);
    node.type = 'button';
    node.tabIndex = -1;
    node.setAttribute('role', 'menuitem');
    node.addEventListener('click', () => { close({ refocus: true }); run(); });
    return node;
  }

  /** Undo or Redo, named after the change; marked unavailable when there is nothing to do. */
  function historyItem(side, label) {
    const verb = side === 'undo' ? 'Undo' : 'Redo';
    const name = label === null ? `Nothing to ${side}` : label ? `${verb}: ${shortText(label, 48)}` : `${verb} last change`;
    const node = item(name, () => { if (label !== null) handlers[side]?.(); });
    const keys = side === 'undo' ? 'Ctrl+Z' : 'Ctrl+Shift+Z';
    node.append(el('span', 'menu-sub', keys));
    node.setAttribute('aria-keyshortcuts', side === 'undo' ? 'Control+Z' : 'Control+Shift+Z Control+Y');
    if (label === null) node.setAttribute('aria-disabled', 'true');
    return node;
  }

  function keys(event) {
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const at = items.indexOf(doc.activeElement);
    const target = { ArrowDown: items[(at + 1) % items.length], ArrowUp: items[(at - 1 + items.length) % items.length], Home: items[0], End: items.at(-1) }[event.key];
    if (target) { event.preventDefault(); target.focus(); }
    else if (event.key === 'Tab') close({ refocus: true });
  }

  async function open() {
    close();
    const started = generation;
    menu = el('div', 'menu status-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Changes and storage');
    menu.addEventListener('keydown', keys);

    const labels = handlers.historyLabels?.() ?? { undo: null, redo: null };
    const redo = historyItem('redo', labels.redo);
    redo.classList.add('menu-group-end');
    menu.append(historyItem('undo', labels.undo), redo);

    const where = el('span', 'menu-sub', 'Reading the folder…');
    const copy = item('Copy folder path', () => {});
    copy.append(where);
    copy.setAttribute('aria-disabled', 'true');
    const reveal = item('Open board folder', () => handlers.revealBoard?.());
    menu.append(copy, reveal);

    button.after(menu);
    button.setAttribute('aria-expanded', 'true');
    reveal.focus();

    const folder = await handlers.boardFolder?.();
    if (started !== generation) return;
    if (folder) {
      where.textContent = folder;
      copy.removeAttribute('aria-disabled');
      copy.addEventListener('click', () => { doc.defaultView?.navigator?.clipboard?.writeText(folder)?.catch?.(() => {}); });
    } else {
      where.textContent = 'Not available';
    }

    if (doc.documentElement.dataset.git !== 'on') return;
    let commit = null;
    try { commit = (await handlers.gitStatus?.())?.detail?.last_commit ?? null; } catch { /* the line stays out */ }
    if (started !== generation || !commit) return;
    const line = el('div', 'menu-note', `Last commit: ${commitTime(commit)}`);
    line.dataset.gitOnly = '';
    line.setAttribute('role', 'menuitem');
    line.setAttribute('aria-disabled', 'true');
    line.tabIndex = -1;
    menu.append(line);
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (menu) close({ refocus: true }); else open();
  });
  doc.addEventListener('click', (event) => { if (menu && !menu.contains(event.target)) close(); });
  doc.addEventListener('keydown', (event) => { if (event.key === 'Escape' && menu) close({ refocus: true }); });
  doc.addEventListener('keydown', (event) => {
    const side = historyKey(event);
    if (!side || !handlers[side] || event.defaultPrevented || event.target?.closest?.(OWN_UNDO)) return;
    event.preventDefault();
    handlers[side]();
  });

  return {
    /** The chip is a menu button while a board is open, plain text otherwise. */
    enable(on) {
      if (!on) close();
      button.disabled = !on;
    },
  };
}
