// The SVG layer over the photo: header markers and callouts, and the pointer tools that place and move them.

import { clampPoint, dragRect, growsLeft, movedRect, newCalloutEvent, nudgedCallout, RESIZE_HANDLES, resizedRect, safeColor } from './core/schema.js';
import { dom } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';
/** An open book on a 16 x 16 grid: two pages and the spine. It marks a callout that has a wiki page. */
const BOOK = 'M8 4.5C7 3.5 5 3 2 3v9c3 0 5 .5 6 1.5 1-1 3-1.5 6-1.5V3c-3 0-5 .5-6 1.5ZM8 4.5v9';

export function createOverlay(doc, handlers, s, parts, draw) {
  const { $ } = dom(doc);
  const svgEl = (name, attrs = {}) => {
    const node = doc.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };
  const stage = $('stage'), overlay = $('overlay');

  /** Pointer position in image pixels. */
  function imagePoint(event) {
    const a = s.asset();
    const box = overlay.getBoundingClientRect();
    if (!a || !box.width) return { x: 0, y: 0 };
    return { x: ((event.clientX - box.left) * a.width) / box.width, y: ((event.clientY - box.top) * a.height) / box.height };
  }

  function setTool(next) {
    s.tool = next;
    $('tool-select').setAttribute('aria-pressed', String(s.tool === 'select'));
    $('tool-box').setAttribute('aria-pressed', String(s.tool === 'box'));
    $('tool-callout').setAttribute('aria-pressed', String(s.tool === 'callout'));
    overlay.dataset.tool = s.tool;
  }
  $('tool-callout').addEventListener('click', () => setTool('callout'));
  $('tool-select').addEventListener('click', () => setTool('select'));
  $('tool-box').addEventListener('click', () => setTool('box'));

  async function placeCallout(point) {
    const a = s.asset();
    const event = newCalloutEvent({ assetId: a.id, x: point.x, y: point.y, width: a.width, height: a.height, unit: 1 / parts.photo.scale() });
    const started = s.generation;
    const id = await handlers.onAddCallout(event);
    if (!id || started !== s.generation) return;
    s.pendingCallout = id;
    s.select({ callout: id });
    setTool('select');
    draw();
    $('callout-text').focus();
  }

  // Arrow keys move the view at once and send one event 400 ms after the last key, or when the selection changes.
  const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  let nudging = null;               // { kind, id, timer } while a moved item waits to be sent

  function flushNudge() {
    if (!nudging) return;
    const { kind, id, timer } = nudging;
    clearTimeout(timer);
    nudging = null;
    const patch = s.preview?.id === id ? s.preview.patch : null;
    s.preview = null;
    const stored = kind === 'marker' ? s.project?.markers.find((m) => m.id === id) : s.project?.annotations?.find((c) => c.id === id);
    if (!s.editable || !patch || !stored || Object.entries(patch).every(([k, v]) => stored[k] === v)) return;
    if (kind === 'marker') handlers.onUpdateMarker(id, patch); else handlers.onUpdateCallout(id, patch);
  }

  function nudge(key, shift) {
    const a = s.asset();
    const dir = ARROWS[key];
    const kind = s.marker() ? 'marker' : 'callout';
    const target = s.marker() ?? s.callout();
    if (!a || !dir || !target) return false;
    if (nudging && nudging.id !== target.id) flushNudge();
    const base = s.preview?.id === target.id ? { ...target, ...s.preview.patch } : target;
    const step = Math.max(1, Math.round(1 / parts.photo.scale())) * (shift ? 10 : 1);
    const patch = kind === 'marker' ? movedRect(base, dir[0] * step, dir[1] * step, a.width, a.height)
      : nudgedCallout(base, dir[0] * step, dir[1] * step, a.width, a.height);
    s.preview = { id: target.id, patch };
    clearTimeout(nudging?.timer);
    nudging = { kind, id: target.id, timer: setTimeout(() => { flushNudge(); draw(); }, 400) };
    parts.photo.drawPhoto();
    return true;
  }

  overlay.addEventListener('pointerdown', (event) => {
    if (!s.editable || !s.asset() || event.button !== 0) return;
    flushNudge();
    stage.focus({ preventScroll: true });          // keeps the shortcuts scoped to this panel after a click on the photo
    const start = imagePoint(event);
    const hit = event.target.closest?.('[data-marker]');
    const handle = event.target.closest?.('[data-handle]')?.dataset.handle;
    const hitCallout = event.target.closest?.('[data-callout]');
    if (s.tool === 'callout') {
      placeCallout(start);
      event.preventDefault();
      return;
    }
    const boxed = s.marker();
    if (s.tool === 'select' && handle && boxed?.shape === 'box') {
      s.drag = { kind: 'resize', handle, start, origin: { x: boxed.x, y: boxed.y, w: boxed.w, h: boxed.h }, moved: null };
    } else if (s.tool === 'select' && hitCallout) {
      s.select({ callout: hitCallout.dataset.callout });
      const c = s.callout();
      const part = event.target.closest?.('[data-part]')?.dataset.part === 'dot' ? 'dot' : 'label';
      s.drag = c ? { kind: 'callout', part, start, origin: { x: c.x, y: c.y, lx: c.lx, ly: c.ly }, moved: null } : null;
      draw();
    } else if (s.tool === 'box') {
      s.drag = { kind: 'box', start, preview: svgEl('rect', { class: 'draft' }) };
      overlay.append(s.drag.preview);
    } else if (hit) {
      const id = hit.dataset.marker;
      if (id !== s.markerId) s.select({ marker: id });
      const m = s.marker();
      s.drag = m?.shape === 'box' ? { kind: 'move', start, origin: { x: m.x, y: m.y, w: m.w, h: m.h }, moved: null } : null;
      draw();
    } else {
      s.select();
      draw();
      return;
    }
    overlay.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  overlay.addEventListener('pointermove', (event) => {
    const a = s.asset();
    const drag = s.drag;
    if (!drag || !a) return;
    const point = imagePoint(event);
    if (drag.kind === 'callout') {
      const dx = point.x - drag.start.x, dy = point.y - drag.start.y;
      const o = drag.origin;
      if (drag.part === 'dot') {
        const p = clampPoint(o.x + dx, o.y + dy, a.width, a.height);
        drag.moved = { x: p.x, y: p.y };
      } else {
        const p = clampPoint(o.lx + dx, o.ly + dy, a.width, a.height);
        drag.moved = { lx: p.x, ly: p.y };
      }
      s.preview = { id: s.calloutId, patch: drag.moved };
      parts.photo.drawPhoto();
    } else if (drag.kind === 'resize') {
      drag.moved = resizedRect(drag.origin, drag.handle, point.x - drag.start.x, point.y - drag.start.y, a.width, a.height);
      s.preview = { id: s.markerId, patch: drag.moved };
      parts.photo.drawPhoto();
    } else if (drag.kind === 'box') {
      const rect = dragRect(drag.start.x, drag.start.y, point.x, point.y, a.width, a.height, 0) ?? { x: drag.start.x, y: drag.start.y, w: 0, h: 0 };
      for (const k of ['x', 'y']) drag.preview.setAttribute(k, rect[k]);
      drag.preview.setAttribute('width', rect.w);
      drag.preview.setAttribute('height', rect.h);
    } else {
      drag.moved = movedRect(drag.origin, point.x - drag.start.x, point.y - drag.start.y, a.width, a.height);
      const group = [...overlay.querySelectorAll('[data-marker]')].find((g) => g.dataset.marker === s.markerId);
      group?.setAttribute('transform', `translate(${drag.moved.x - drag.origin.x} ${drag.moved.y - drag.origin.y})`);
    }
  });

  async function endDrag(event) {
    if (!s.drag) return;
    const current = s.drag;
    s.drag = null;
    const started = s.generation;
    const a = s.asset();
    if (!a) {                                       // the photo was removed while the pointer was down
      current.preview?.remove?.();
      s.preview = null;
      draw();
      return;
    }
    if (current.kind === 'callout') {
      s.preview = null;
      if (current.moved && Object.entries(current.moved).some(([k, v]) => current.origin[k] !== v)) {
        await handlers.onUpdateCallout(s.calloutId, current.moved);
      }
      draw();
    } else if (current.kind === 'resize') {
      s.preview = null;
      if (current.moved && Object.entries(current.moved).some(([k, v]) => current.origin[k] !== v)) {
        await handlers.onUpdateMarker(s.markerId, current.moved);
      }
      draw();
    } else if (current.kind === 'box') {
      current.preview.remove();
      const point = imagePoint(event);
      const rect = dragRect(current.start.x, current.start.y, point.x, point.y, a.width, a.height);
      if (rect) {
        const id = await handlers.onAddMarker(a.id, rect);
        if (id && started === s.generation) { s.select({ marker: id }); setTool('select'); }
      }
      draw();
    } else {
      if (current.moved && (current.moved.x !== current.origin.x || current.moved.y !== current.origin.y)) {
        await handlers.onUpdateMarker(s.markerId, current.moved);
      }
      draw();
    }
  }
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', () => { s.drag?.preview?.remove?.(); s.drag = null; s.preview = null; draw(); });

  /** Short tag on a photo label: AI guesses stay visibly unconfirmed until someone checks them. */
  function guessTag(guess) {
    if (!guess) return '';
    const off = doc.documentElement.dataset.assistant === 'off';
    if (doc.documentElement.dataset.guidance === 'expert') return off ? ' · unverified' : ' · AI?';
    return ` · ${off ? 'unverified' : 'AI guess'}, ${guess.confidence}`;
  }

  /** Callouts: a dot on the part, a leader line, a label. Guided draws large labels; Expert shows them on hover. */
  function drawCallouts(a, unit) {
    const size = (doc.documentElement.dataset.guidance === 'expert' ? 12 : 15) * unit;
    return (s.project.annotations ?? []).filter((c) => c.assetId === a.id).map((stored) => {
      const c = s.preview?.id === stored.id ? { ...stored, ...s.preview.patch } : stored;
      const selected = c.id === s.calloutId;
      const group = svgEl('g', { 'data-callout': c.id, class: `callout${selected ? ' selected' : ''}${c.text ? '' : ' empty'}${c.guess ? ' guess' : ''}` });
      const text = (c.text || 'New callout') + guessTag(c.guess);
      const pad = 5 * unit;
      const width = text.length * size * 0.6 + 2 * pad + (c.wiki ? size : 0);
      const left = growsLeft(c.lx, c.x, width, a.width);
      const height = size + 2 * pad;
      const boxX = left ? c.lx - width : c.lx;
      group.append(svgEl('line', { x1: c.x, y1: c.y, x2: c.lx, y2: c.ly, 'stroke-width': (selected ? 2.5 : 1.5) * unit }));
      const dot = svgEl('circle', { cx: c.x, cy: c.y, r: (selected ? 6 : 4.5) * unit, 'stroke-width': 1.5 * unit, 'data-part': 'dot' });
      const label = svgEl('g', { class: 'label', 'data-part': 'label' });
      label.append(svgEl('rect', { x: boxX, y: c.ly - height / 2, width, height, rx: 3 * unit, 'stroke-width': unit }));
      const words = svgEl('text', { x: boxX + pad, y: c.ly, 'font-size': size, 'dominant-baseline': 'central' });
      words.textContent = text;
      label.append(words);
      if (c.wiki) {
        // A small open book at the right end of the label, drawn on a 16 x 16 grid and scaled with the label.
        const book = size * 0.8;
        label.append(svgEl('path', {
          class: 'book', d: BOOK, fill: 'none', 'stroke-width': 1.4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          transform: `translate(${boxX + width - pad - book} ${c.ly - book / 2}) scale(${book / 16})`,
        }));
        const title = svgEl('title');
        title.textContent = `About this: ${c.wiki}. Select it and use "Open wiki page".`;
        label.append(title);
      }
      group.append(label, dot);
      return group;
    });
  }

  function drawMarkers(a, unit) {
    return s.project.markers.filter((m) => m.assetId === a.id).map((stored) => {
      const m = s.preview?.id === stored.id ? { ...stored, ...s.preview.patch } : stored;
      const group = svgEl('g', { 'data-marker': m.id, class: m.id === s.markerId ? 'marker selected' : 'marker' });
      const color = safeColor(m.color);
      if (color) group.style.setProperty('--marker', color);
      if (m.shape === 'crosshair') {
        const r = 12 * unit;
        group.append(svgEl('circle', { cx: m.x, cy: m.y, r, 'stroke-width': 2 * unit }));
        group.append(svgEl('path', { d: `M${m.x - 2 * r} ${m.y}H${m.x + 2 * r}M${m.x} ${m.y - 2 * r}V${m.y + 2 * r}`, 'stroke-width': unit }));
      } else {
        group.append(svgEl('rect', { x: m.x, y: m.y, width: m.w ?? 0, height: m.h ?? 0, 'stroke-width': (m.id === s.markerId ? 3 : 2) * unit }));
      }
      const sch = s.project.schematics.find((s2) => s2.id === m.schematicId);
      const text = m.label || sch?.name || '';
      if (text) {
        const label = svgEl('text', { x: m.x, y: m.y - 6 * unit, 'font-size': 13 * unit, 'stroke-width': 3 * unit });
        label.textContent = text;
        group.append(label);
      }
      return group;
    });
  }

  /** Eight square handles on the selected box, 8 screen pixels wide at any zoom. */
  function drawHandles(a, unit) {
    const m = s.marker();
    if (!s.editable || s.tool !== 'select' || m?.shape !== 'box' || m.assetId !== a.id) return [];
    const box = s.preview?.id === m.id ? { ...m, ...s.preview.patch } : m;
    const size = 8 * unit;
    const at = { w: box.x, e: box.x + box.w, n: box.y, s: box.y + box.h };
    const group = svgEl('g', { class: 'handles' });
    for (const name of RESIZE_HANDLES) {
      const x = name.includes('w') ? at.w : name.includes('e') ? at.e : box.x + box.w / 2;
      const y = name.includes('n') ? at.n : name.includes('s') ? at.s : box.y + box.h / 2;
      group.append(svgEl('rect', { class: 'handle', 'data-handle': name, x: x - size / 2, y: y - size / 2, width: size, height: size, 'stroke-width': unit }));
    }
    return [group];
  }

  return {
    setTool,
    nudge,
    /** Send a waiting arrow-key move when the selection has moved on. Called before every redraw. */
    settle() { if (nudging && nudging.id !== (s.markerId ?? s.calloutId)) flushNudge(); },
    /** Drop a waiting move without sending it, for a board that is gone. */
    cancelNudge() { if (nudging) clearTimeout(nudging.timer); nudging = null; },
    /** Size the layer to the photo and draw every marker and callout on it. */
    render(a, unit) {
      overlay.setAttribute('viewBox', `0 0 ${a.width} ${a.height}`);
      // Strokes and text are sized in screen pixels whatever the zoom.
      overlay.style.setProperty('--unit', String(unit));
      overlay.replaceChildren(...drawMarkers(a, unit), ...drawCallouts(a, unit), ...drawHandles(a, unit));
    },
  };
}
