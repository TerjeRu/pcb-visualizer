// Client-side copy of the project state, kept current by applying the service's events.
//
// This is a port of service/src/pcbv/reducer.py. service/tests/test_client_parity.py runs both over the
// same events and real journals: if this file drifts from the service, that test fails.
//
// Pure functions, no DOM, no I/O.

const PIN_BASE_KEYS = new Set(['index', 'role', 'label', 'color', 'note']);
const replaceById = (list, id, fn) => list.map((item) => (item.id === id ? fn(item) : item));

/** The patch merged in, then the keys in `unset` removed (an undo of a patch that added them). */
function patched(record, event) {
  const merged = { ...record, ...event.patch };
  for (const key of event.unset ?? []) delete merged[key];
  return merged;
}

/** Appended, or put back at `at` (an undo of its removal). */
const inserted = (list, item, at) => (at === undefined ? [...list, item] : [...list.slice(0, at), item, ...list.slice(at)]);

const pinHasContent = (pin) =>
  Boolean(pin.role || pin.label || pin.color || pin.note || Object.keys(pin).some((key) => !PIN_BASE_KEYS.has(key)));

/** Apply one event's change to the project data. Mirrors projectReducer. Throws on unknown types. */
export function reduceProject(project, event) {
  switch (event.type) {
    case 'board/batch':
      return event.events.reduce(reduceProject, project);
    case 'project/created':
    case 'project/replaced':
      return structuredClone(event.project);

    case 'project/metaUpdated':
      return { ...project, meta: patched(project.meta, event) };

    case 'asset/added':
      return { ...project, assets: inserted(project.assets, event.asset, event.at) };
    case 'asset/updated':
      return { ...project, assets: replaceById(project.assets, event.id, (a) => patched(a, event)) };
    case 'asset/removed': {
      const markers = project.markers.filter((m) => m.assetId !== event.id);
      const used = new Set(markers.map((m) => m.schematicId));
      return {
        ...project,
        assets: project.assets.filter((a) => a.id !== event.id),
        markers,
        schematics: project.schematics.filter((s) => used.has(s.id)),
        components: project.components.filter((c) => c.assetId !== event.id),
        ...(project.annotations ? { annotations: project.annotations.filter((a) => a.assetId !== event.id) } : {}),
      };
    }

    case 'capture/started':
      return { ...project, captures: [...(project.captures ?? []), event.capture] };
    case 'capture/stopped':
    case 'capture/updated':
      return { ...project, captures: replaceById(project.captures ?? [], event.id, (c) => ({ ...c, ...event.patch })) };

    case 'annotation/added':
      return { ...project, annotations: inserted(project.annotations ?? [], event.annotation, event.at) };
    case 'annotation/updated':
      return { ...project, annotations: replaceById(project.annotations ?? [], event.id, (a) => patched(a, event)) };
    case 'annotation/removed':
      return { ...project, annotations: (project.annotations ?? []).filter((a) => a.id !== event.id) };

    case 'marker/added':
      return {
        ...project,
        markers: inserted(project.markers, event.marker, event.at),
        schematics: event.schematic ? inserted(project.schematics, event.schematic, event.schematicAt) : project.schematics,
      };
    case 'marker/updated':
      return { ...project, markers: replaceById(project.markers, event.id, (m) => patched(m, event)) };
    case 'marker/removed': {
      const marker = project.markers.find((m) => m.id === event.id);
      if (!marker) return project;
      const markers = project.markers.filter((m) => m.id !== event.id);
      const stillUsed = markers.some((m) => m.schematicId === marker.schematicId);
      return {
        ...project,
        markers,
        schematics: stillUsed ? project.schematics : project.schematics.filter((s) => s.id !== marker.schematicId),
      };
    }

    case 'schematic/updated':
      return { ...project, schematics: replaceById(project.schematics, event.id, (s) => patched(s, event)) };

    case 'pin/readingAdded': {
      const schematic = project.schematics.find((s) => s.id === event.schematicId);
      const pin = schematic.pins.find((p) => p.index === event.index);
      return reduceProject(project, { type: 'pin/updated', schematicId: event.schematicId, index: event.index, patch: { readings: [...(pin?.readings ?? []), event.reading] } });
    }

    case 'pin/updated':
      return {
        ...project,
        schematics: replaceById(project.schematics, event.schematicId, (s) => {
          const existing = s.pins.find((p) => p.index === event.index);
          let pins;
          if (event.patch === null) {
            pins = s.pins.filter((p) => p.index !== event.index);
          } else if (existing) {
            pins = s.pins.map((p) => (p.index === event.index ? { ...p, ...event.patch } : p));
          } else {
            pins = [...s.pins, { index: event.index, role: '', label: '', color: '', note: '', ...event.patch }]
              .sort((a, b) => a.index - b.index);
          }
          return { ...s, pins: pins.filter(pinHasContent) };
        }),
      };

    case 'components/replaced':
      return { ...project, components: event.components };

    case 'playbook/updated': {
      // Progress per playbook; with stepId the patch merges into that step, otherwise into the playbook.
      // With unset, what it leaves empty is removed: an undo of a first tick leaves no trace.
      const all = { ...(project.playbooks ?? {}) };
      const record = all[event.playbookId] ?? {};
      const pruning = 'unset' in event;
      let next;
      if (event.stepId) {
        const steps = { ...(record.steps ?? {}), [event.stepId]: patched(record.steps?.[event.stepId] ?? {}, event) };
        if (pruning && !Object.keys(steps[event.stepId]).length) delete steps[event.stepId];
        next = { ...record, steps };
        if (pruning && !Object.keys(steps).length) delete next.steps;
      } else {
        next = patched(record, event);
      }
      if (pruning && !Object.keys(next).length) delete all[event.playbookId];
      else all[event.playbookId] = next;
      return { ...project, playbooks: all };
    }

    default:
      throw new Error(`unknown event type ${JSON.stringify(event.type)}`);
  }
}

const NON_MUTATING = new Set(['project/created', 'project/replaced']);

/** Apply one stored event the way the service does: meta.modified follows the event time. */
export function applyEvent(project, event) {
  const next = reduceProject(project, event);
  if (NON_MUTATING.has(event.type)) return next;
  return { ...next, meta: { ...next.meta, modified: event.ts } };
}

/** Rebuild a project from a list of stored events, first event must be project/created. */
export function replay(events) {
  if (!events.length || events[0].type !== 'project/created') {
    throw new Error('event list does not start with project/created');
  }
  let project = null;
  for (const event of events) project = applyEvent(project, event);
  return project;
}
