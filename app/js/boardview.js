// The board photo with its markers, and the inspector for the selected header.
// Like ui.js it only draws and reports intents; controller.js turns intents into events. Board text is
// untrusted and only ever set with textContent or value. Selection, tool and zoom are view state
// (boardstate.js) and never leave the panel. The parts: photoview.js, overlay.js, inspector.js and
// calloutform.js.

import { createBoardState } from './boardstate.js';
import { createCalloutForm } from './calloutform.js';
import { roleForKey } from './core/schema.js';
import { dom } from './dom.js';
import { createInspector } from './inspector.js';
import { createOverlay } from './overlay.js';
import { createPhotoView } from './photoview.js';

// Board shortcuts work only while focus is in the Header panel or the photo, never in a console or a form.
const SHORTCUT_SCOPE = '#panel-inspector, #panel-photo';
const ARROW_KEYS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1 };

export function createBoardView(doc, handlers) {
  const { $ } = dom(doc);
  const s = createBoardState();
  const parts = {};
  let notedPin = null;            // the selected pin last reported, so the tutorial hears about changes only
  parts.photo = createPhotoView(doc, handlers, s, parts, draw);
  parts.overlay = createOverlay(doc, handlers, s, parts, draw);
  parts.calloutForm = createCalloutForm(doc, handlers, s, parts);
  parts.inspector = createInspector(doc, handlers, s, parts, draw);

  // Shortcuts while a pin is selected: role keys from PIN_ROLES, Backspace clears, Escape steps back.
  doc.addEventListener('keydown', (event) => {
    if (!s.editable || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!event.target.closest?.(SHORTCUT_SCOPE) || event.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (event.key === 'Escape') {
      if (s.pinIndex) s.pinIndex = null; else if (s.markerId || s.calloutId) s.select(); else parts.overlay.setTool('select');
      draw();
      return;
    }
    if (s.pinIndex && s.schematic()) {
      const role = roleForKey(event.key);
      if (role) { parts.inspector.setPinRole(role.role); event.preventDefault(); return; }
      if (event.key === 'Backspace' || event.key === 'Delete') { parts.inspector.clearPin(); event.preventDefault(); }
      return;
    }
    if (event.key in ARROW_KEYS && !event.target.closest?.('.menu') && parts.overlay.nudge(event.key, event.shiftKey)) { event.preventDefault(); return; }
    if (s.markerId && (event.key === 'Delete' || event.key === 'Backspace')) { parts.inspector.removeMarker(); event.preventDefault(); }
    if (s.calloutId && (event.key === 'Delete' || event.key === 'Backspace')) { parts.calloutForm.remove(); event.preventDefault(); }
  });

  function draw() {
    if (!s.project) return;
    parts.overlay.settle();
    if (!s.asset()) s.assetId = s.project.assets[0]?.id ?? null;
    if (s.markerId && !s.marker()) { s.markerId = null; s.pinIndex = null; }
    if (s.calloutId && s.callout()) s.pendingCallout = null;
    else if (s.calloutId && s.calloutId !== s.pendingCallout) s.calloutId = null;
    for (const id of ['tool-select', 'tool-box', 'tool-callout', 'photo-file']) $(id).disabled = !s.editable;
    $('add-photo').classList.toggle('disabled', !s.editable);
    for (const id of ['zoom-in', 'zoom-out', 'zoom-fit', 'photo-ask']) $(id).disabled = !s.asset();
    parts.photo.drawTabs();
    parts.photo.drawPhoto();
    parts.photo.drawList();
    parts.inspector.draw();
    if (s.pinIndex !== notedPin) { notedPin = s.pinIndex; handlers.notePin?.(notedPin); }
  }

  return {
    render(nextProject, isEditable) {
      s.project = nextProject;
      s.editable = isEditable;
      if (!s.drag) draw();
    },
    /** Show a photo, marker or callout, for example from the timeline. */
    focus(target) {
      const { project } = s;
      if (!project) return;
      if (target.kind === 'asset' && project.assets.some((a) => a.id === target.id)) { s.assetId = target.id; s.select(); }
      const m = target.kind === 'marker' ? project.markers.find((x) => x.id === target.id) : null;
      if (m) { s.assetId = m.assetId; s.select({ marker: m.id }); }
      const c = target.kind === 'callout' ? (project.annotations ?? []).find((x) => x.id === target.id) : null;
      if (c) { s.assetId = c.assetId; s.select({ callout: c.id }); }
      s.zoom = null;
      parts.overlay.setTool('select');
      draw();
      $('stage').scrollIntoView?.({ block: 'nearest' });
    },
    /** Board switched: forget the selection and the photo on screen. */
    reset() {
      s.generation += 1;
      s.assetId = s.markerId = s.calloutId = s.pinIndex = s.shownPath = s.preview = null;
      s.zoom = null;
      s.drag = null;
      parts.overlay.cancelNudge();
      parts.overlay.setTool('select');
    },
  };
}
