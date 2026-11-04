// The photo of the Board panel: its tabs, zoom, upload, and the list of what is marked on it.

import { dom } from './dom.js';

const ZOOM_STEPS = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];

export function createPhotoView(doc, handlers, s, parts, draw) {
  const { $ } = dom(doc);
  const stage = $('stage'), canvas = $('canvas'), photo = $('photo');

  function scale() {
    const a = s.asset();
    if (!a) return 1;
    if (s.zoom !== null) return s.zoom;
    const width = stage.clientWidth, height = stage.clientHeight;
    if (!width || !height) return 1;               // not laid out yet (or under jsdom)
    return Math.min(1, (width - 16) / a.width, (height - 16) / a.height);
  }

  function stepZoom(direction) {
    const current = scale();
    const next = direction > 0 ? ZOOM_STEPS.find((z) => z > current + 1e-6) : [...ZOOM_STEPS].reverse().find((z) => z < current - 1e-6);
    s.zoom = next ?? current;
    handlers.noteZoom?.();
    draw();
  }
  $('zoom-in').addEventListener('click', () => stepZoom(1));
  $('zoom-out').addEventListener('click', () => stepZoom(-1));
  $('zoom-fit').addEventListener('click', () => { s.zoom = null; draw(); });
  doc.defaultView?.addEventListener('resize', () => { if (s.zoom === null) draw(); });

  $('photo-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const started = s.generation;
    const id = await handlers.onUploadPhoto(file, $('photo-side').value);
    if (id && started === s.generation) { s.assetId = id; s.select(); s.zoom = null; draw(); }
  });

  $('photo-ask').addEventListener('click', () => {
    if (!s.assetId) return;
    const m = s.marker();
    handlers.onAsk?.('What can you see on this photo? Identify the main parts and any likely debug headers.',
      { photo: s.assetId, ...(m?.label ? { header: m.label } : {}) });
  });

  return {
    scale,
    drawTabs() {
      $('photo-tabs').replaceChildren(...s.project.assets.map((a) => {
        const tab = doc.createElement('button');
        tab.type = 'button';
        tab.className = 'tab';
        tab.textContent = a.label || a.side || 'Photo';
        tab.title = a.side ? `${a.side} photo` : '';
        tab.setAttribute('aria-pressed', String(a.id === s.assetId));
        tab.addEventListener('click', () => { s.assetId = a.id; s.select(); s.zoom = null; draw(); });
        return tab;
      }));
    },

    drawPhoto() {
      const a = s.asset();
      $('viewer-empty').hidden = Boolean(a);
      canvas.hidden = !a;
      if (!a) { s.shownPath = null; photo.removeAttribute('src'); return; }
      const scaleNow = scale();
      canvas.style.width = `${Math.round(a.width * scaleNow)}px`;
      canvas.style.height = `${Math.round(a.height * scaleNow)}px`;
      $('zoom-label').textContent = `${Math.round(scaleNow * 100)}%`;
      if (s.shownPath !== a.path) {
        s.shownPath = a.path;
        photo.removeAttribute('src');
        photo.alt = a.label || 'Board photo';
        const wanted = a.path;
        const started = s.generation;
        handlers.loadPhoto(wanted).then((url) => { if (started === s.generation && s.shownPath === wanted && url) photo.src = url; }, () => {});
      }
      parts.overlay.render(a, 1 / scaleNow);
    },

    /** Every marker and callout as a button, so the photo's contents can be chosen without a pointer. The selection is the one the photo draws. */
    drawList() {
      const items = [
        ...s.project.markers.map((m) => {
          const sch = s.project.schematics.find((x) => x.id === m.schematicId);
          return { key: `marker:${m.id}`, kind: 'marker', id: m.id, assetId: m.assetId, name: m.label || sch?.name || 'Unnamed marker', type: m.shape === 'crosshair' ? 'Point marker' : 'Header marker' };
        }),
        ...(s.project.annotations ?? []).map((c) => ({ key: `callout:${c.id}`, kind: 'callout', id: c.id, assetId: c.assetId, name: c.text || 'Unnamed callout', type: 'Callout' })),
      ];
      const list = $('annotation-list');
      const focused = list.contains(doc.activeElement) ? doc.activeElement.dataset.key : null;
      $('annotation-box').hidden = items.length === 0;
      list.replaceChildren(...items.map((item) => {
        const row = doc.createElement('li');
        const button = doc.createElement('button');
        button.type = 'button';
        button.dataset.key = item.key;
        button.setAttribute('aria-pressed', String(item.id === (item.kind === 'marker' ? s.markerId : s.calloutId)));
        const name = doc.createElement('span');
        name.textContent = item.name;
        const type = doc.createElement('span');
        type.className = 'kind';
        type.textContent = item.type;
        button.append(name, type);
        button.addEventListener('click', () => {
          if (item.assetId !== s.assetId) { s.assetId = item.assetId; s.zoom = null; }
          s.select(item.kind === 'marker' ? { marker: item.id } : { callout: item.id });
          draw();
        });
        row.append(button);
        return row;
      }));
      if (focused) list.querySelector(`[data-key="${focused}"]`)?.focus();
    },
  };
}
