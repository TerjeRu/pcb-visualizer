// The photo of the Board panel: its tabs, zoom, upload, and the list of what is marked on it.

import { dom } from './dom.js';
import { createPopupMenu } from './popupmenu.js';

const MAX_LABEL_CHARS = 80;      // the service refuses a longer photo label (MAX_LABEL_CHARS in events.py)

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** The one file to upload from dropped or pasted files, and the notice to show: a wrong type gets no file. */
export function pickPhoto(files) {
  const list = [...files];
  const file = list.find((f) => PHOTO_TYPES.includes(f.type)) ?? null;
  if (!file) return { file: null, notice: 'Use a JPEG, PNG or WebP photo.' };
  return { file, notice: list.length > 1 ? 'Added the first photo only.' : null };
}

const WHEEL_STEP = 50;           // wheel distance for one zoom step; a mouse notch is about 100, a pinch sends many small ones

/** How far to scroll along one axis so the image point under the pointer stays under it after a zoom. Positions are screen pixels; `start` is the photo's edge. */
export function zoomShift(pointer, oldStart, newStart, oldScale, newScale) {
  return newStart + ((pointer - oldStart) / oldScale) * newScale - pointer;
}

/** What Remove photo asks: the photo's name, and what goes with it. */
export function removeQuestion(project, asset) {
  const count = (list, one) => { const n = list.filter((x) => x.assetId === asset.id).length; return n ? `${n} ${one}${n === 1 ? '' : 's'}` : null; };
  const parts = [count(project.markers, 'marker'), count(project.annotations ?? [], 'callout')].filter(Boolean);
  return `Remove the photo "${asset.label || 'Photo'}"?` + (parts.length ? ` This also removes ${parts.join(' and ')} on it.` : '');
}

const ZOOM_STEPS = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];

export function createPhotoView(doc, handlers, s, parts, draw) {
  const { $, el } = dom(doc);
  const menu = createPopupMenu(doc);
  let renaming = null;             // { id, draft } while a tab is a text box
  let rebuilding = false;
  const stage = $('stage'), canvas = $('canvas'), photo = $('photo');

  function scale() {
    const a = s.asset();
    if (!a) return 1;
    if (s.zoom !== null) return s.zoom;
    const width = stage.clientWidth, height = stage.clientHeight;
    if (!width || !height) return 1;               // not laid out yet (or under jsdom)
    return Math.min(1, (width - 16) / a.width, (height - 16) / a.height);
  }

  /** Set the zoom (null fits). With a pointer position, the image point under it stays where it is. */
  function zoomTo(next, pointer) {
    const oldScale = scale();
    const before = pointer ? canvas.getBoundingClientRect() : null;
    s.zoom = next;
    if (next !== null) handlers.noteZoom?.();
    draw();
    if (!before) return;
    const after = canvas.getBoundingClientRect();
    stage.scrollLeft += zoomShift(pointer.x, before.left, after.left, oldScale, scale());
    stage.scrollTop += zoomShift(pointer.y, before.top, after.top, oldScale, scale());
  }

  function stepZoom(direction, pointer) {
    const current = scale();
    const next = direction > 0 ? ZOOM_STEPS.find((z) => z > current + 1e-6) : [...ZOOM_STEPS].reverse().find((z) => z < current - 1e-6);
    zoomTo(next ?? current, pointer);
  }
  $('zoom-in').addEventListener('click', () => stepZoom(1));
  $('zoom-out').addEventListener('click', () => stepZoom(-1));
  $('zoom-fit').addEventListener('click', () => { s.zoom = null; draw(); });

  let wheelSum = 0;
  stage.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return;                        // a plain wheel scrolls the stage
    event.preventDefault();                            // and Ctrl+wheel must not zoom the whole page
    if (!s.asset()) return;
    wheelSum += event.deltaY;
    if (Math.abs(wheelSum) < WHEEL_STEP) return;
    stepZoom(wheelSum < 0 ? 1 : -1, { x: event.clientX, y: event.clientY });
    wheelSum = 0;
  }, { passive: false });

  // Panning: the middle button, or Space held with the left button. Space still types in text boxes.
  let spaceHeld = false;
  let panning = null;
  const setSpace = (on) => { spaceHeld = on; stage.classList.toggle('pan-ready', on); };
  stage.addEventListener('keydown', (event) => {
    if (event.key !== ' ' || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();                            // the stage would scroll down a page
    setSpace(true);
  });
  stage.addEventListener('keyup', (event) => { if (event.key === ' ') setSpace(false); });
  stage.addEventListener('blur', () => setSpace(false));
  stage.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault(); });   // no autoscroll cursor
  stage.addEventListener('pointerdown', (event) => {
    if (!s.asset() || !(event.button === 1 || (event.button === 0 && spaceHeld))) return;
    event.preventDefault();
    event.stopPropagation();                           // the overlay must not start a tool
    panning = { id: event.pointerId, x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.classList.add('panning');
    stage.setPointerCapture?.(event.pointerId);
  }, true);
  stage.addEventListener('pointermove', (event) => {
    if (!panning || event.pointerId !== panning.id) return;
    stage.scrollLeft = panning.left - (event.clientX - panning.x);
    stage.scrollTop = panning.top - (event.clientY - panning.y);
  });
  const endPan = () => { panning = null; stage.classList.remove('panning'); };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);

  // + and - zoom and 0 fits, while focus is in the photo panel and not in a text box.
  $('panel-photo').addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.('input, textarea, select, [contenteditable]') || !s.asset()) return;
    if (event.key === '+' || event.key === '=') stepZoom(1);
    else if (event.key === '-') stepZoom(-1);
    else if (event.key === '0') zoomTo(null);
    else return;
    event.preventDefault();
  });
  doc.defaultView?.addEventListener('resize', () => { if (s.zoom === null) draw(); });

  async function addPhoto(file, notice = null) {
    const started = s.generation;
    const id = await handlers.onUploadPhoto(file);
    if (!id || started !== s.generation) return;
    if (notice) handlers.onNotice?.(notice);        // only once the photo was added
    s.assetId = id; s.select(); s.zoom = null; draw();
  }

  $('photo-file').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) addPhoto(file);
  });

  const viewer = $('drop-hint').parentElement;
  const carriesFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
  const showDrop = (on) => { viewer.classList.toggle('drop-ready', on); $('drop-hint').hidden = !on; };
  function addPicked(files) {
    const { file, notice } = pickPhoto(files);
    if (file) addPhoto(file, notice);
    else handlers.onNotice?.(notice);
  }
  // A file dropped anywhere else would make the browser leave the app, so the stage always takes the event.
  const overDrop = (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = s.editable ? 'copy' : 'none';
    showDrop(s.editable);
  };
  let dragDepth = 0;               // dragenter and dragleave also fire for every child the file passes over
  stage.addEventListener('dragenter', (event) => { if (carriesFiles(event)) dragDepth += 1; overDrop(event); });
  stage.addEventListener('dragover', overDrop);
  stage.addEventListener('dragleave', (event) => {
    if (!carriesFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) showDrop(false);
  });
  stage.addEventListener('drop', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    showDrop(false);
    if (s.editable) addPicked(event.dataTransfer.files);
  });

  $('panel-photo').addEventListener('paste', (event) => {
    const images = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;                        // text pastes into a text box as usual
    event.preventDefault();
    if (s.editable) addPicked(images);
  });

  function showPhoto(id) { s.assetId = id; s.select(); s.zoom = null; draw(); }

  function tabButton(a) {
    const tab = el('button', 'tab', a.label || 'Photo');
    tab.type = 'button';
    tab.dataset.asset = a.id;
    tab.setAttribute('aria-pressed', String(a.id === s.assetId));
    tab.addEventListener('click', () => showPhoto(a.id));
    return tab;
  }

  // A press on a tab takes the focus out of the rename box, which redraws the tabs before the click
  // arrives, so the click never reaches the tab. The box shows that photo itself.
  let pressedTab = null;
  $('photo-tabs').addEventListener('pointerdown', (event) => { pressedTab = event.target.closest?.('.tab')?.dataset.asset ?? null; }, true);
  for (const type of ['pointerup', 'pointercancel']) doc.addEventListener(type, () => { pressedTab = null; }, true);

  function focusRenameBox() {
    const input = $('photo-tabs').querySelector('.tab-input');
    input?.focus();
    input?.select();
  }

  const menuButtonOf = (id) => [...$('photo-tabs').querySelectorAll('.photo-menu-button')].find((b) => b.dataset.asset === id);

  function menuButton(a) {
    const button = el('button', 'photo-menu-button', '⋯');
    button.type = 'button';
    button.setAttribute('aria-label', `Photo actions for ${a.label || 'Photo'}`);
    button.dataset.asset = a.id;
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (menu.isOpenFor(button)) { menu.close({ refocus: true }); return; }
      menu.open(button, `Photo actions for ${a.label || 'Photo'}`, [
        { label: 'Rename', run: () => { renaming = { id: a.id, draft: a.label ?? '' }; draw(); focusRenameBox(); } },
        { label: 'Rotate left', run: () => handlers.onRotatePhoto?.(a.id, -1) },
        { label: 'Rotate right', run: () => handlers.onRotatePhoto?.(a.id, 1) },
        { label: 'Remove photo', danger: true, run: () => removePhoto(a) },
      ], 'photo-menu');
    });
    return button;
  }

  function renameBox(a) {
    const input = el('input', 'tab-input');
    input.type = 'text';
    input.maxLength = MAX_LABEL_CHARS;
    input.value = renaming.draft;
    input.setAttribute('aria-label', 'Photo name');
    let finished = false;
    const finish = (save, refocus = false) => {
      if (finished) return;
      finished = true;
      const name = input.value.trim().slice(0, MAX_LABEL_CHARS);
      renaming = null;
      if (save && s.editable && name && name !== a.label) handlers.onUpdateAsset?.(a.id, { label: name });
      draw();
      if (refocus) menuButtonOf(a.id)?.focus();
    };
    input.addEventListener('input', () => { renaming.draft = input.value; });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true, true); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false, true); }
    });
    input.addEventListener('blur', () => {
      if (rebuilding) return;
      const next = pressedTab;
      finish(true);
      if (next && next !== s.assetId && s.project.assets.some((x) => x.id === next)) showPhoto(next);
    });
    return input;
  }

  function removePhoto(a) {
    const win = doc.defaultView;
    if (win?.confirm && !win.confirm(removeQuestion(s.project, a))) { menuButtonOf(a.id)?.focus(); return; }
    handlers.onRemoveAsset?.(a.id);
  }

  $('photo-ask').addEventListener('click', () => {
    if (!s.assetId) return;
    const m = s.marker();
    handlers.onAsk?.('What can you see on this photo? Identify the main parts and any likely debug headers.',
      { photo: s.assetId, ...(m?.label ? { header: m.label } : {}) });
  });

  return {
    scale,
    drawTabs() {
      if (renaming && !s.project.assets.some((a) => a.id === renaming.id)) renaming = null;
      const focused = $('photo-tabs').contains(doc.activeElement) ? doc.activeElement : null;
      const menuAsset = menu.opener()?.dataset.asset;     // a redraw closes the menu; focus goes back to its button
      menu.close();
      const refocus = focused && menuAsset && !focused.dataset.asset ? { kind: 'photo-menu-button', asset: menuAsset } : focused && { box: focused.classList.contains('tab-input'), asset: focused.dataset.asset, kind: focused.className };
      rebuilding = true;           // taking the old text box out of the page must not count as leaving it
      $('photo-tabs').replaceChildren(...s.project.assets.map((a) => {
        const group = el('span', 'tab-group menu-anchor');
        const isRenamed = Boolean(renaming) && renaming.id === a.id;
        group.append(isRenamed ? renameBox(a) : tabButton(a));
        if (s.editable && !isRenamed) group.append(menuButton(a));
        return group;
      }));
      rebuilding = false;
      if (refocus) {                // the buttons are new elements: put the focus on the same one
        const same = refocus.box ? $('photo-tabs').querySelector('.tab-input')
          : [...$('photo-tabs').querySelectorAll(`.${refocus.kind.split(' ')[0]}`)].find((b) => b.dataset.asset === refocus.asset);
        same?.focus();
      }
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
