// Undo and redo for the changes one window makes. The journal is append-only, so an undo is a new event
// built from the board before the change: `inverse` puts back exactly what the change replaced. `targets`
// names what the change touched; reading them again before an undo tells whether something else changed
// them since. Pure, so tests run in Node.

import { reduceProject } from './apply.js';

export const HISTORY_LIMIT = 100;
export const MAX_BATCH = 256;          // events in one board/batch; events.py refuses more
export const NOTES_RUN_MS = 60_000;    // notes saves this close together are one change

const listOf = (project, name) => project?.[name] ?? [];
const position = (items, id) => items.findIndex((item) => item.id === id);
const omit = (record, key) => Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
const keysOf = (event) => [...Object.keys(event.patch ?? {}), ...(event.unset ?? [])];

/** The patch that puts back the old values of the keys a patch event set or removed. */
function patchBack(record, event) {
  const keys = keysOf(event);
  const had = (key) => Object.hasOwn(record ?? {}, key);
  // fromEntries makes own keys, so even a key named __proto__ comes back as a value
  const patch = Object.fromEntries(keys.filter(had).map((key) => [key, record[key]]));
  const unset = keys.filter((key) => !had(key));
  return unset.length ? { patch, unset } : { patch };
}

/** Where an item goes back: after the items that came before it and are there again. */
function slot(beforeItems, id, nowItems) {
  const present = new Set(nowItems.map((item) => item.id));
  return beforeItems.slice(0, position(beforeItems, id)).filter((item) => present.has(item.id)).length;
}

const schematicDropped = (project, marker) => !project.markers.some((m) => m.id !== marker.id && m.schematicId === marker.schematicId);

/** The batch that brings back a removed photo with everything the removal took. */
function photoBack(before, id) {
  const events = [];
  let staged = reduceProject(before, { type: 'asset/removed', id });
  const add = (event) => { events.push(event); staged = reduceProject(staged, event); };
  const asset = listOf(before, 'assets').find((a) => a.id === id);
  add({ type: 'asset/added', asset, at: slot(before.assets, id, staged.assets) });
  for (const marker of before.markers.filter((m) => m.assetId === id)) {
    const event = { type: 'marker/added', marker, at: slot(before.markers, marker.id, staged.markers) };
    if (!staged.schematics.some((s) => s.id === marker.schematicId)) {
      event.schematic = before.schematics.find((s) => s.id === marker.schematicId);
      event.schematicAt = slot(before.schematics, marker.schematicId, staged.schematics);
    }
    add(event);
  }
  for (const note of listOf(before, 'annotations').filter((a) => a.assetId === id)) {
    add({ type: 'annotation/added', annotation: note, at: slot(before.annotations, note.id, staged.annotations) });
  }
  if (listOf(before, 'components').some((c) => c.assetId === id)) add({ type: 'components/replaced', components: before.components });
  return events;
}

/** A pin goes back whole: cleared, then added as it was. Readings are part of the pin. */
function pinBack(before, schematicId, index) {
  const old = listOf(before, 'schematics').find((s) => s.id === schematicId)?.pins?.find((p) => p.index === index);
  const clear = { type: 'pin/updated', schematicId, index, patch: null };
  return old ? [clear, { type: 'pin/updated', schematicId, index, patch: omit(old, 'index') }] : [clear];
}

const asOne = (events) => (events.length === 1 ? events[0] : { type: 'board/batch', events });

/**
 * The event that undoes `event`, built from the board before it. Null when it cannot be undone: an
 * event the app does not send, or one whose undo would not fit in a batch.
 */
export function inverse(event, before) {
  const steps = inverseSteps(event, before);
  return steps && steps.length <= MAX_BATCH ? asOne(steps) : null;
}

function inverseSteps(event, before) {
  switch (event?.type) {
    case 'board/batch': {
      let staged = before;
      const back = [];
      for (const child of event.events) {
        const steps = inverseSteps(child, staged);
        if (!steps) return null;
        back.unshift(...steps);
        staged = reduceProject(staged, child);
      }
      return back;
    }
    case 'project/metaUpdated':
      return [{ type: event.type, ...patchBack(before.meta, event) }];
    case 'asset/added':
      return [{ type: 'asset/removed', id: event.asset.id }];
    case 'asset/removed':
      return photoBack(before, event.id);
    case 'marker/added':
      return [{ type: 'marker/removed', id: event.marker.id }];
    case 'marker/removed': {
      const marker = before.markers.find((m) => m.id === event.id);
      if (!marker) return null;
      const back = { type: 'marker/added', marker, at: position(before.markers, marker.id) };
      if (schematicDropped(before, marker)) {
        back.schematic = before.schematics.find((s) => s.id === marker.schematicId);
        back.schematicAt = position(before.schematics, marker.schematicId);
      }
      return [back];
    }
    case 'annotation/added':
      return [{ type: 'annotation/removed', id: event.annotation.id }];
    case 'annotation/removed': {
      const note = listOf(before, 'annotations').find((a) => a.id === event.id);
      return note ? [{ type: 'annotation/added', annotation: note, at: position(before.annotations, note.id) }] : null;
    }
    case 'asset/updated':
    case 'marker/updated':
    case 'schematic/updated':
    case 'annotation/updated': {
      const name = { asset: 'assets', marker: 'markers', schematic: 'schematics', annotation: 'annotations' }[event.type.split('/')[0]];
      const record = listOf(before, name).find((item) => item.id === event.id);
      return record ? [{ type: event.type, id: event.id, ...patchBack(record, event) }] : null;
    }
    case 'pin/updated':
    case 'pin/readingAdded':
      return pinBack(before, event.schematicId, event.index);
    case 'components/replaced':
      return [{ type: event.type, components: listOf(before, 'components') }];
    case 'playbook/updated': {
      const record = before.playbooks?.[event.playbookId];
      const target = event.stepId ? record?.steps?.[event.stepId] : record;
      return [{ type: event.type, playbookId: event.playbookId, ...(event.stepId ? { stepId: event.stepId } : {}), ...patchBack(target, event) }];
    }
    default:
      return null;
  }
}

/** What `event` touches, named so `read` can look at it on any later board. */
export function targets(event, before) {
  switch (event?.type) {
    case 'board/batch': {
      let staged = before;
      const all = [];
      for (const child of event.events) {
        all.push(...targets(child, staged));
        staged = reduceProject(staged, child);
      }
      return all;
    }
    case 'project/metaUpdated':
      return [{ kind: 'meta', keys: keysOf(event) }];
    case 'asset/added':
      return [{ kind: 'photo', id: event.asset.id }];
    case 'asset/removed':
      // Its undo puts back the whole components list, so a change to another photo's components counts too.
      return [{ kind: 'photo', id: event.id },
        ...(listOf(before, 'components').some((c) => c.assetId === event.id) ? [{ kind: 'components' }] : [])];
    case 'marker/added':
      return [{ kind: 'record', list: 'markers', id: event.marker.id },
        ...(event.schematic ? [{ kind: 'record', list: 'schematics', id: event.schematic.id }] : [])];
    case 'marker/removed': {
      const marker = before.markers.find((m) => m.id === event.id);
      return [{ kind: 'record', list: 'markers', id: event.id },
        ...(marker && schematicDropped(before, marker) ? [{ kind: 'record', list: 'schematics', id: marker.schematicId }] : [])];
    }
    case 'annotation/added':
      return [{ kind: 'record', list: 'annotations', id: event.annotation.id }];
    case 'annotation/removed':
      return [{ kind: 'record', list: 'annotations', id: event.id }];
    case 'asset/updated':
    case 'marker/updated':
    case 'schematic/updated':
    case 'annotation/updated': {
      const list = { asset: 'assets', marker: 'markers', schematic: 'schematics', annotation: 'annotations' }[event.type.split('/')[0]];
      return [{ kind: 'record', list, id: event.id, keys: keysOf(event) }];
    }
    case 'pin/updated':
    case 'pin/readingAdded':
      return [{ kind: 'pin', schematicId: event.schematicId, index: event.index }];
    case 'components/replaced':
      return [{ kind: 'components' }];
    case 'playbook/updated':
      return [{ kind: 'playbook', playbookId: event.playbookId, stepId: event.stepId ?? null, keys: keysOf(event) }];
    default:
      return [];
  }
}

const pick = (record, keys) => (record && keys ? Object.fromEntries(keys.filter((k) => Object.hasOwn(record, k)).map((k) => [k, record[k]])) : record ?? null);

/** The current values of the targets, to compare with `sameValues`. */
export function read(list, project) {
  return list.map((target) => {
    switch (target.kind) {
      case 'meta':
        return pick(project.meta, target.keys);
      case 'photo': {
        const markers = listOf(project, 'markers').filter((m) => m.assetId === target.id);
        const used = new Set(markers.map((m) => m.schematicId));
        return {
          asset: listOf(project, 'assets').find((a) => a.id === target.id) ?? null,
          markers,
          schematics: listOf(project, 'schematics').filter((s) => used.has(s.id)),
          annotations: listOf(project, 'annotations').filter((a) => a.assetId === target.id),
          components: listOf(project, 'components').filter((c) => c.assetId === target.id),
        };
      }
      case 'record':
        return pick(listOf(project, target.list).find((item) => item.id === target.id), target.keys);
      case 'pin':
        return listOf(project, 'schematics').find((s) => s.id === target.schematicId)?.pins?.find((p) => p.index === target.index) ?? null;
      case 'components':
        return listOf(project, 'components');
      case 'playbook': {
        const record = project.playbooks?.[target.playbookId];
        return pick(target.stepId ? record?.steps?.[target.stepId] : record, target.keys);
      }
      default:
        return null;
    }
  });
}

/** Deep equality of JSON values; key order does not count. */
export function sameValues(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && sameValues(a[key], b[key]));
}

const onlyNotes = (event) => event.type === 'project/metaUpdated' && keysOf(event).join() === 'notes' && !event.unset;

/**
 * One step of the history for a stored change: the event that undoes it, what it touched and the
 * values it left. Null when it cannot be undone.
 */
export function entryFor(event, before, after, label) {
  const back = inverse(event, before);
  if (!back) return null;
  const touched = targets(event, before);
  return { label, back, targets: touched, expected: read(touched, after), notes: onlyNotes(event) };
}

/** True while the board still has the values the entry's change left. */
export const stillThere = (entry, project) => sameValues(read(entry.targets, project), entry.expected);

/** The undo and redo lists of one window. Entries come from `entryFor`. */
export function createHistory({ limit = HISTORY_LIMIT, now = () => Date.now() } = {}) {
  let undo = [];
  let redo = [];
  const trim = (list) => (list.length > limit ? list.slice(list.length - limit) : list);
  return {
    /** A new change: it can be undone, and nothing is left to redo. A change that cannot be undone ends the history. */
    changed(entry) {
      redo = [];
      if (!entry) { undo = []; return; }
      const top = undo.at(-1);
      const at = now();
      if (entry.notes && top?.notes && at - top.at < NOTES_RUN_MS) {
        undo = [...undo.slice(0, -1), { ...top, expected: entry.expected, at }];
      } else {
        undo = trim([...undo, { ...entry, at }]);
      }
    },
    /** The next entry to undo or redo, or null. */
    peek: (side) => (side === 'undo' ? undo : redo).at(-1) ?? null,
    /** Take the next entry off its list. */
    take(side) {
      if (side === 'undo') undo = undo.slice(0, -1); else redo = redo.slice(0, -1);
    },
    /** What an undo or redo wrote, as an entry for the other list. Null drops both lists' order, so both are cleared. */
    reversed(side, entry) {
      if (!entry) { undo = []; redo = []; return; }
      const other = { ...entry, at: now() };
      if (side === 'undo') redo = trim([...redo, other]); else undo = trim([...undo, other]);
    },
    clear() { undo = []; redo = []; },
    /** The labels of the next undo and redo, for the menu: null when there is none, '' when it has no name. */
    labels: () => ({ undo: undo.length ? undo.at(-1).label ?? '' : null, redo: redo.length ? redo.at(-1).label ?? '' : null }),
  };
}
