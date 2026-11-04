// The Header inspector of the Board panel: the selected header's fields, its pin grid and the pin form.

import { describeGuess, guessName } from './core/format.js';
import { MAX_GRID, NUMBERING, PIN_ROLES, ROTATIONS, getPin, pinLayout, roleDef, safeColor } from './core/schema.js';
import { dom } from './dom.js';
import { describeReadings } from './viewmodel.js';

// Wiki page explaining each pin role, linked from the pin panel.
const ROLE_PAGES = { TX: 'uart', RX: 'uart', GND: 'ground', VCC: 'logic-levels', '3V3': 'logic-levels', '5V': 'logic-levels' };

const gridSize = (v) => Math.min(Math.max(Math.round(Number(v)) || 1, 1), MAX_GRID);

export function createInspector(doc, handlers, s, parts, draw) {
  const { $, options, setValue } = dom(doc);

  function setPinRole(role) {
    const sch = s.schematic();
    if (!sch || !s.pinIndex) return;
    handlers.onUpdatePin(sch.id, s.pinIndex, { role, color: roleDef(role)?.color ?? '' });
  }

  function removeMarker() {
    const m = s.marker();
    if (!m) return;
    const name = m.label || 'this marker';
    if (doc.defaultView?.confirm && !doc.defaultView.confirm(`Remove ${name} and its pin labels?`)) return;
    handlers.onRemoveMarker(m.id);
    s.markerId = null;
    s.pinIndex = null;
  }

  /** Clearing a pin that carries a role together with readings or a note asks first, in Guided and Expert alike. */
  function clearPin() {
    const sch = s.schematic();
    const pin = getPin(sch, s.pinIndex);
    const loses = pin?.role && (pin.readings?.length || pin.note);
    if (loses && doc.defaultView?.confirm && !doc.defaultView.confirm(`Clear pin ${s.pinIndex} (${pin.role})? This also removes its readings and note.`)) return;
    handlers.onUpdatePin(sch.id, s.pinIndex, null);
  }

  const fieldHandlers = {
    'marker-label': (v) => handlers.onUpdateMarker(s.markerId, { label: v.trim() }),
    'header-name': (v) => handlers.onUpdateSchematic(s.schematic().id, { name: v.trim() }),
    'header-rows': (v) => handlers.onUpdateSchematic(s.schematic().id, { rows: gridSize(v) }),
    'header-cols': (v) => handlers.onUpdateSchematic(s.schematic().id, { cols: gridSize(v) }),
    'header-numbering': (v) => handlers.onUpdateSchematic(s.schematic().id, { numbering: v }),
    'header-rotation': (v) => handlers.onUpdateSchematic(s.schematic().id, { rotation: Number(v) }),
    'header-notes': (v) => handlers.onUpdateSchematic(s.schematic().id, { notes: v }),
    'pin-role': (v) => setPinRole(v),
    'pin-label': (v) => handlers.onUpdatePin(s.schematic().id, s.pinIndex, { label: v.trim() }),
    'pin-note': (v) => handlers.onUpdatePin(s.schematic().id, s.pinIndex, { note: v }),
  };
  for (const [id, fn] of Object.entries(fieldHandlers)) {
    $(id).addEventListener('change', (event) => { if (s.marker() && s.schematic()) fn(event.target.value); });
  }

  $('marker-delete').addEventListener('click', () => removeMarker());
  $('pin-clear').addEventListener('click', () => { if (s.schematic() && s.pinIndex) clearPin(); });
  $('pin-guess-use').addEventListener('click', (event) => setPinRole(event.currentTarget.dataset.role));
  $('pin-ask').addEventListener('click', () => {
    const m = s.marker();
    const sch = s.schematic();
    if (!sch || !s.pinIndex) return;
    const header = m?.label || sch.name || 'this header';
    handlers.onAsk?.(`What can you tell me about pin ${s.pinIndex} of ${header}?`, { header, pin: s.pinIndex });
  });

  options($('pin-role'), ['', ...PIN_ROLES.map((r) => r.role)].map((role) => ({
    value: role,
    label: role ? `${role}  (${roleDef(role).key})` : '(none)',
  })));
  $('pin-keys').textContent = `Click a pin, then press a key: ${PIN_ROLES.map((r) => `${r.key} ${r.role}`).join(', ')}. Backspace clears.`;
  options($('header-numbering'), Object.entries(NUMBERING).map(([value, label]) => ({ value, label })));
  options($('header-rotation'), ROTATIONS.map((deg) => ({ value: String(deg), label: `${deg}°` })));

  return {
    setPinRole,
    removeMarker,
    clearPin,
    draw() {
      const m = s.marker();
      const sch = s.schematic();
      const c = s.callout();
      $('inspector-heading').textContent = c ? 'Callout' : 'Header';
      $('callout-form').hidden = !c;
      if (c) {
        $('inspector-empty').hidden = true;
        $('inspector-form').hidden = true;
        parts.calloutForm.draw(c);
        return;
      }
      $('inspector-empty').hidden = Boolean(m && sch);
      $('inspector-form').hidden = !(m && sch);
      if (!m || !sch) return;
      for (const input of $('inspector-form').querySelectorAll('input, select, textarea, button')) input.disabled = !s.editable;
      setValue($('marker-label'), m.label);
      setValue($('header-name'), sch.name);
      setValue($('header-rows'), sch.rows);
      setValue($('header-cols'), sch.cols);
      setValue($('header-numbering'), sch.numbering || 'row');
      setValue($('header-rotation'), String(sch.rotation || 0));
      setValue($('header-notes'), sch.notes);

      const layout = pinLayout(sch);
      if (s.pinIndex && s.pinIndex > layout.pins.length) s.pinIndex = null;
      const grid = $('pin-grid');
      const hadFocus = grid.contains(doc.activeElement);
      grid.style.gridTemplateColumns = `repeat(${layout.width}, 2.6em)`;
      grid.replaceChildren(...layout.pins.map(({ index, x, y }) => {
        const pin = getPin(sch, index);
        const cell = doc.createElement('button');
        cell.type = 'button';
        cell.className = 'pin';
        cell.style.gridColumn = String(x + 1);
        cell.style.gridRow = String(y + 1);
        const pinColor = safeColor(pin?.color);
        if (pinColor) cell.style.setProperty('--pin', pinColor);
        cell.dataset.role = pin?.role || '';
        const guessed = !pin?.role && pin?.guess?.role;
        cell.classList.toggle('guessed', Boolean(guessed));
        cell.setAttribute('aria-pressed', String(index === s.pinIndex));
        cell.setAttribute('aria-label', `Pin ${index}${pin?.role ? `, ${pin.role}` : ''}${guessed ? `, ${guessName(doc.documentElement.dataset.assistant)} ${guessed}` : ''}${pin?.label ? `, ${pin.label}` : ''}`);
        const last = pin?.readings?.at?.(-1);
        cell.title = last?.text ? `Last reading: ${last.text}` : '';
        const number = doc.createElement('span');
        number.className = 'n';
        number.textContent = String(index);
        const role = doc.createElement('span');
        role.className = 'r';
        role.textContent = pin?.role || pin?.label || (guessed ? `${guessed}?` : '');
        cell.append(number, role);
        cell.addEventListener('click', () => { s.pinIndex = index; draw(); grid.querySelector('[aria-pressed="true"]')?.focus(); });
        return cell;
      }));
      if (hadFocus) grid.querySelector('[aria-pressed="true"]')?.focus();

      const pin = s.pinIndex ? getPin(sch, s.pinIndex) : null;
      $('pin-form').hidden = !s.pinIndex;
      $('pin-heading').textContent = s.pinIndex ? `Pin ${s.pinIndex}` : '';
      if (s.pinIndex) {
        setValue($('pin-role'), pin?.role ?? '');
        setValue($('pin-label'), pin?.label ?? '');
        setValue($('pin-note'), pin?.note ?? '');
        const guess = pin?.guess?.role && pin.guess.role !== pin.role ? pin.guess : null;
        $('pin-guess').hidden = !guess;
        if (guess) {
          $('pin-guess-text').textContent = describeGuess(guess, `${guessName(doc.documentElement.dataset.assistant)} ${guess.role}`);
          $('pin-guess-use').textContent = `Use ${guess.role} as the role`;
          $('pin-guess-use').dataset.role = guess.role;
        }
        const page = ROLE_PAGES[pin?.role];
        $('pin-wiki').hidden = !page;
        if (page) {
          const link = doc.createElement('a');
          link.href = `#wiki/${page}`;
          link.className = 'wiki-link';
          link.textContent = `What is ${pin.role}?`;
          link.addEventListener('click', (event) => { event.preventDefault(); handlers.onOpenWiki?.(page); });
          $('pin-wiki').replaceChildren(link);
        }
        const lines = describeReadings(pin);
        $('pin-readings').hidden = !lines.length;
        $('pin-readings').replaceChildren(...lines.map((line) => {
          const item = doc.createElement('li');
          item.textContent = line;
          return item;
        }));
      }
    },
  };
}
