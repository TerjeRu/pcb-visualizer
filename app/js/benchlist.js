// The bench check as a list: a text mark (not colour only), the label and, when the check fails, the
// command that fixes it. Used by the Welcome card and the Settings dialog. `checks` comes from
// GET /api/bench-check; `failure` is the text to show when it could not be read.

import { dom } from './dom.js';

export function drawChecks(doc, list, checks, failure) {
  const { el } = dom(doc);
  if (!checks) { list.replaceChildren(el('li', '', `Could not run the checks: ${failure}`)); return; }
  list.replaceChildren(...checks.map((check) => {
    const item = el('li', 'bench-check');
    item.dataset.ok = String(check.ok);
    item.append(el('strong', '', check.ok ? 'OK' : 'Missing'), ` ${check.label}`);
    if (!check.ok) item.append(' ', el('code', '', check.fix));
    return item;
  }));
}
