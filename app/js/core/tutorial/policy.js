// Which changes the tutorial lets through. Every board change is an event through the controller; while the
// tutorial runs, the controller asks `allowed(step, event, project)` first and does not send a refused one.
// Mistakes inside the task are allowed (a wrong pin role on J4 is part of learning); anything outside the
// step is not. Actions that are not events (opening a port, exporting) ask `allowedAction(step, name)`.
// Pure: no DOM, no service calls.

import { centreInside } from './facts.js';

export const REFUSED = 'Not needed for this step.';

const keysWithin = (patch, allowed) => Boolean(patch) && typeof patch === 'object' && Object.keys(patch).every((key) => allowed.includes(key));

function j4(project) {
  const marker = project?.markers?.find((m) => m.shape === 'box' && centreInside(m)) ?? null;
  return { marker, schematic: marker ? project.schematics.find((s) => s.id === marker.schematicId) ?? null : null };
}

const PIN_KEYS = ['role', 'color', 'label', 'note'];

const RULES = {
  marker: {
    added: (step, event, project) => step === 3 && project.markers.length === 0 && event.marker?.shape === 'box'
      && project.assets.some((a) => a.id === event.marker.assetId),
    updated: (step, event, project) => {
      const target = project.markers.find((m) => m.id === event.id);
      if (!target) return false;
      if (step === 3) return keysWithin(event.patch, ['x', 'y', 'w', 'h']);
      return step === 4 && target === j4(project).marker && keysWithin(event.patch, ['label']);
    },
  },
  schematic: {
    updated: (step, event, project) => {
      const { schematic } = j4(project);
      if (!schematic || schematic.id !== event.id) return false;
      if (step === 4) return keysWithin(event.patch, ['name', 'rows', 'cols']);
      return step === 17 && keysWithin(event.patch, ['name', 'notes']);
    },
  },
  pin: {
    updated: (step, event, project) => {
      const { schematic } = j4(project);
      if (!schematic || schematic.id !== event.schematicId || step < 5 || step > 8) return false;
      return event.patch === null || keysWithin(event.patch, PIN_KEYS);
    },
    readingAdded: (step, event, project) => {
      const { schematic } = j4(project);
      return Boolean(schematic) && schematic.id === event.schematicId && step >= 5 && step <= 7;
    },
  },
};

/** True when the event may be sent at this step (1 to 18). */
export function allowed(step, event, project) {
  const [kind, verb] = String(event?.type ?? '').split('/');
  const rule = Object.hasOwn(RULES, kind) && Object.hasOwn(RULES[kind], verb) ? RULES[kind][verb] : null;
  return Boolean(rule) && rule(step, event, project ?? { markers: [], schematics: [], assets: [] });
}

const ACTIONS = {
  'bench-power': [5, 6, 7],
  'bench-mode': [5, 6, 7],
  'bench-probe': [5, 6, 7],
  wire: [9],
  'vdev-start': [10, 11, 12, 13, 14],
  'serial-open': [10, 11, 12, 13, 14],
  'serial-write': [13, 14],
  'serial-detect': [],
  'logic-import': [],
  'logic-decode': [15, 16],
  'logic-compare': [16],
  export: [18],
  reveal: [],
  'photo-rotate': [],
  undo: [],
};

export const ACTION_NAMES = Object.keys(ACTIONS);

/** True when a step lets the person do an action that is not a board event. */
export const allowedAction = (step, name) => Object.hasOwn(ACTIONS, name) && ACTIONS[name].includes(step);
