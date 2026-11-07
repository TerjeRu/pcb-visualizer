// One popup menu at a time under a button: arrow keys, Home and End move between items, Esc and Tab close it.
// The button's parent must be positioned (class menu-anchor). The keys follow the Panels menu in dock.js.

import { dom } from './dom.js';

export function createPopupMenu(doc) {
  const { el } = dom(doc);
  let menu = null;
  let opener = null;

  function close({ refocus = false } = {}) {
    const button = opener;
    menu?.remove();
    menu = null;
    opener = null;
    button?.setAttribute('aria-expanded', 'false');
    if (refocus) button?.focus();
  }

  function keys(event) {
    const items = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const at = items.indexOf(doc.activeElement);
    const target = { ArrowDown: items[(at + 1) % items.length], ArrowUp: items[(at - 1 + items.length) % items.length], Home: items[0], End: items.at(-1) }[event.key];
    if (target) { event.preventDefault(); target.focus(); }
    else if (event.key === 'Tab') close({ refocus: true });
  }

  doc.addEventListener('click', (event) => { if (menu && !menu.contains(event.target)) close(); });
  doc.addEventListener('keydown', (event) => { if (event.key === 'Escape' && menu) close({ refocus: true }); });

  return {
    close,
    isOpenFor: (button) => opener === button,
    opener: () => opener,
    /** Show `items` ({ label, run, danger, disabled }) under `button`. An item closes the menu, then runs. */
    open(button, label, items, className = '') {
      close();
      menu = el('div', `menu ${className}`.trim());
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', label);
      menu.addEventListener('keydown', keys);
      for (const { label: text, run, danger, disabled } of items) {
        const item = el('button', danger ? 'danger' : '', text);
        item.type = 'button';
        item.tabIndex = -1;
        item.disabled = Boolean(disabled);
        item.setAttribute('role', 'menuitem');
        item.addEventListener('click', () => { close({ refocus: true }); run(); });
        menu.append(item);
      }
      button.after(menu);
      opener = button;
      button.setAttribute('aria-expanded', 'true');
      menu.querySelector('button:not(:disabled)')?.focus();
    },
  };
}
