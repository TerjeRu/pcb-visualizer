// Plain-language descriptions of state, kept free of the DOM so they can be tested.

import { shortText } from './core/format.js';

const COUNT_LABELS = [['assets', 'photo', 'photos'], ['markers', 'marker', 'markers'], ['schematics', 'header', 'headers'], ['components', 'component', 'components']];

export function summarize(project) {
  if (!project) return null;
  return {
    name: project.meta?.name || 'Untitled board',
    device: project.meta?.device || '',
    notes: project.meta?.notes || '',
    modified: project.meta?.modified || '',
    counts: COUNT_LABELS.map(([key, one, many]) => {
      const n = Array.isArray(project[key]) ? project[key].length : 0;
      return { key, n, label: n === 1 ? one : many };
    }),
  };
}

const short = (value, max = 40) => shortText(value, max);

/** One line describing a stored event. Never throws, whatever the event contains. */
export function describeEvent(event, guess = 'AI guess') {
  const e = event && typeof event === 'object' ? event : {};
  switch (e.type) {
    case 'project/created': return `Board created: ${short(e.project?.meta?.name)}`;
    case 'project/replaced': return 'File edited outside the service. The edit was kept.';
    case 'project/metaUpdated':
      if (Object.keys(e.patch ?? {}).join() === 'mode') return `Mode: ${e.patch.mode === 'expert' ? 'Expert' : 'Guided'}`;
      return `Board details changed: ${short(Object.keys(e.patch ?? {}).join(', '))}`;
    case 'asset/added': return `Photo added: ${short(e.asset?.label ?? e.asset?.path)}`;
    case 'asset/updated': return `Photo changed: ${short(e.id)}`;
    case 'asset/removed': return `Photo removed: ${short(e.id)}`;
    case 'marker/added': return `Marker added${e.marker?.label ? `: ${short(e.marker.label)}` : ''}`;
    case 'marker/updated': return `Marker changed: ${short(e.id)}`;
    case 'marker/removed': return `Marker removed: ${short(e.id)}`;
    case 'schematic/updated': return `Header changed: ${short(e.id)}`;
    case 'board/batch': return `Group of ${Array.isArray(e.events) ? e.events.length : 0} changes`;
    case 'pin/readingAdded': return `Pin ${short(e.index)} reading: ${short(e.reading?.text ?? '?')}`;
    case 'pin/updated': {
      if (e.patch === null) return `Pin ${short(e.index)} cleared`;
      const readings = Array.isArray(e.patch?.readings) ? e.patch.readings : null;
      if (readings) return `Pin ${short(e.index)} reading: ${short(readings.at(-1)?.text ?? '?')}`;
      if (e.patch?.guess) return `${guess} for pin ${short(e.index)}: ${short(e.patch.guess.role)} (${short(e.patch.guess.confidence)})`;
      if (e.patch && 'note' in e.patch && !e.patch.role) return `Pin ${short(e.index)} note changed`;
      return `Pin ${short(e.index)} set${e.patch?.role ? ` to ${short(e.patch.role)}` : ''}`;
    }
    case 'capture/started':
      if (e.capture?.kind === 'logic') return `Logic capture imported: ${short(e.capture.label)}`;
      if (e.capture?.kind === 'shell') return `Shell session started: ${short(e.capture.label)}`;
      return `Console opened: ${short(e.capture?.label ?? e.capture?.port)} at ${short(e.capture?.baud)} baud`;
    case 'capture/stopped': return `${e.patch?.kind === 'shell' ? 'Shell session ended' : 'Console closed'}${e.patch?.bytes !== undefined ? `, ${short(e.patch.bytes)} bytes captured` : ''}${e.patch?.reason && e.patch.reason !== 'closed' ? ` (${short(e.patch.reason)})` : ''}`;
    case 'capture/updated':
      if (Array.isArray(e.patch?.decoded)) return `Decoded UART on ${short(e.patch.decoded.map((d) => d.name).join(', ') || 'no channel')}`;
      if (e.patch?.compare) return `Compared with console capture: ${Math.round((e.patch.compare.ratio ?? 0) * 100)}% the same`;
      return `Console saw: ${short(Array.isArray(e.patch?.seen) ? e.patch.seen.join(', ') : '')}`;
    case 'annotation/added':
      if (e.annotation?.guess) return `${guess} added: ${short(e.annotation.text)} (${short(e.annotation.guess.confidence)})`;
      return `Callout added${e.annotation?.text ? `: ${short(e.annotation.text)}` : ''}`;
    case 'annotation/updated':
      if (e.patch && 'guess' in e.patch && e.patch.guess === null) return 'Callout checked';
      return e.patch?.text ? `Callout text: ${short(e.patch.text)}` : 'Callout changed';
    case 'annotation/removed': return 'Callout removed';
    case 'playbook/updated': {
      const where = e.stepId ? `${short(e.playbookId)} / ${short(e.stepId)}` : short(e.playbookId);
      const p = e.patch ?? {};
      if ('done' in p) return p.done ? `Step done: ${where}` : `Step reopened: ${where}`;
      if (p.gates) return `Safety points updated: ${where}`;
      if (p.answers) return `Answer saved: ${where}`;
      return `Playbook progress: ${where}`;
    }
    case 'components/replaced': return `Components replaced (${Array.isArray(e.components) ? e.components.length : 0})`;
    default: return `Unknown change: ${short(e.type)}`;
  }
}

const STATUS_TEXT = {
  idle: 'Not connected',
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  rejected: 'Refused',
  closed: 'Closed',
};

export function statusLabel(status) {
  return STATUS_TEXT[status] ?? 'Unknown';
}

/** A time like 16:02:11 for the feed; falls back to the raw text for anything unparseable. */
export function clock(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso ?? '') : date.toTimeString().slice(0, 8);
}

/** One line per reading, newest first, for the pin panel. */
export function describeReadings(pin) {
  const readings = Array.isArray(pin?.readings) ? pin.readings : [];
  return readings.slice().reverse().map((r) => {
    const what = String(r?.text ?? '?');
    const power = r?.powered === true ? 'powered' : r?.powered === false ? 'unpowered' : '';
    return [what, power, clock(r?.ts), r?.source ? `via ${r.source}` : ''].filter(Boolean).join(' · ');
  });
}
