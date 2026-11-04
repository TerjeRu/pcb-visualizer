// Starts the app: wires the controller to the page.

import * as api from './api.js';
import { BoardClient } from './client.js';
import { createController } from './controller.js';
import { CHANNEL_NAME } from './panelbus.js';
import { requestCodeFromOpener } from './session.js';
import { createDesktopShell } from './shell.js';
import { createView } from './ui.js';

/** sessionStorage can be blocked (private windows, strict settings); fall back to memory for this load. */
function pickStorage() {
  try {
    const probe = '__pcbv_probe__';
    window.sessionStorage.setItem(probe, '1');
    window.sessionStorage.removeItem(probe);
    return window.sessionStorage;
  } catch {
    const memory = new Map();
    return { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: (k) => memory.delete(k) };
  }
}

// A window opened for one panel carries ?panel=console&board=slug&gen=n.
const query = new URLSearchParams(window.location.search);
const single = query.get('panel');
const generation = Number(query.get('gen'));
// Only a panel window starts from the board and counter it was opened with; the main window counts from the clock.
const panelStart = single ? { slug: query.get('board'), generation: Number.isSafeInteger(generation) ? generation : 0 } : {};
const shell = createDesktopShell(window.__TAURI__, window.location.origin);

/** Panel windows reach each other over a channel; some browser settings leave none. */
function openChannel() {
  try { return new BroadcastChannel(CHANNEL_NAME); } catch { return null; }
}

/** Raise this window after another window sent it work. The browser may refuse; the action still runs. */
function focusWindow() {
  try {
    const current = window.__TAURI__?.window?.getCurrentWindow?.();
    if (current) current.setFocus().catch(() => {}); else window.focus();
  } catch { /* focus is a courtesy */ }
}

// The controller reaches the view only when it runs, so it is built first and the view is filled in after.
const view = {};
const controller = createController({
  env: { location: window.location, history: window.history, storage: pickStorage(), open: (...a) => window.open(...a),
    boardFromQuery: query.get('board'), shell, single: Boolean(single),
    // Only a panel window has an opener to ask; a window opened by hand gets the usual sign-in text.
    requestCode: window.opener ? () => requestCodeFromOpener(window) : undefined },
  view,
  api,
  makeClient: (options) => new BoardClient(options),
  baseUrl: window.location.origin,
});

// The views call the controller by its own method names. Only the calls that read as events, and
// the edits that go through `send`, are named differently here.
Object.assign(view, createView(document, {
  ...controller,
  focusWindow,
  onSelectBoard: controller.selectBoard,
  onCreateBoard: controller.createBoard,
  onSubmitToken: controller.submitToken,
  onSaveDetails: controller.saveDetails,
  onUploadPhoto: controller.uploadPhoto,
  onAddMarker: controller.addMarker,
  onUpdateMarker: (id, patch) => controller.send({ type: 'marker/updated', id, patch }),
  onRemoveMarker: (id) => controller.send({ type: 'marker/removed', id }),
  onUpdateSchematic: (id, patch) => controller.send({ type: 'schematic/updated', id, patch }),
  onUpdatePin: (schematicId, index, patch) => controller.send({ type: 'pin/updated', schematicId, index, patch }),
  onAddCallout: async (event) => ((await controller.send(event)) ? event.annotation.id : null),
  onUpdateCallout: (id, patch) => controller.send({ type: 'annotation/updated', id, patch }),
  onRemoveCallout: (id) => controller.send({ type: 'annotation/removed', id }),
  onSetGuidance: controller.setGuidance,
  onSetTheme: controller.setTheme,
  onSetSetting: controller.setSetting,
  onPlaybookUpdate: (playbookId, stepId, patch) => controller.send({ type: 'playbook/updated', playbookId, stepId, patch }),
}, undefined, { single, channel: openChannel(), ...panelStart }));

controller.start();
window.addEventListener('pagehide', () => controller.stop());
window.addEventListener('message', (event) => controller.answerCodeRequest(event));
// `pcbv open` in a tab that is already open only changes the fragment, which does not reload the page.
// Reload so the new code is exchanged instead of the old token the restarted service no longer knows.
window.addEventListener('hashchange', () => { if (window.location.hash.includes('code=')) window.location.reload(); });
