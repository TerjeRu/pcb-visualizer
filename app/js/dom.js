// DOM helpers shared by the panels. Values go in with textContent or properties, never as markup.

import { classifyLine, createScreen } from './core/terminal.js';

export function dom(doc) {
  const $ = (id) => doc.getElementById(id);

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /** Replace the choices of a select. An item is {value, label, title?, selected?}. */
  const options = (select, items) => {
    select.replaceChildren(...items.map(({ value, label, title, selected }) => {
      const option = doc.createElement('option');
      option.value = value;
      option.textContent = label;
      if (title) option.title = title;
      if (selected !== undefined) option.selected = selected;
      return option;
    }));
  };

  /** One div per line of terminal text, classed by what the line says (see classifyLine). */
  const screenRows = (text) => {
    const screen = createScreen(20000);
    screen.write(text);
    return screen.lines().map((line) => {
      const row = el('div', '', line || '\u00a0');
      const kind = classifyLine(line);
      if (kind) row.className = `ln-${kind}`;
      return row;
    });
  };

  /** Set a field from the board unless the person is typing in it. */
  const setValue = (input, value) => { if (doc.activeElement !== input) input.value = value ?? ''; };

  return { $, el, options, screenRows, setValue };
}
