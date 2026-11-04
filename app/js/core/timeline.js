// The board's history as readable entries: one per journal event worth showing, plus git commits.
// Each entry has a kind (for filters), a title, an optional detail and an optional jump target the
// app knows how to open. Pure, so tests run in Node. Never throws, whatever an event contains.

import { formatRate, headerName, shortText } from './format.js';

export const KINDS = [
  ['photo', 'Photos'],
  ['header', 'Headers and pins'],
  ['reading', 'Readings'],
  ['console', 'Console'],
  ['playbook', 'Playbooks'],
  ['note', 'Notes and callouts'],
  ['commit', 'Commits'],
  ['board', 'Board'],
];

const str = shortText;
const list = (v) => (Array.isArray(v) ? v : []);

function bytes(n) {
  if (typeof n !== 'number') return '';
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} bytes`;
}

/** One entry for an event, or null for events not worth a line of their own. */
export function describe(event, project, playbooks = [], guess = 'AI guess') {
  const e = event && typeof event === 'object' ? event : {};
  const base = { seq: e.seq, ts: e.ts, actor: e.actor };
  const header = (schematicId) => headerName(project, schematicId);
  const known = list(playbooks);
  const playbookTitle = (id) => known.find((p) => p.id === id)?.title || id;
  const stepTitle = (pid, sid) => list(known.find((p) => p.id === pid)?.steps).find((s) => s.id === sid)?.title || sid;
  const p = e.patch && typeof e.patch === 'object' ? e.patch : {};

  switch (e.type) {
    case 'board/batch':
      return { ...base, kind: 'board', title: `Group of ${list(e.events).length} changes` };
    case 'project/created':
      return { ...base, kind: 'board', title: `Board created: ${str(e.project?.meta?.name)}` };
    case 'project/replaced':
      return { ...base, kind: 'board', title: 'File edited outside the app. The edit was kept.' };
    case 'project/metaUpdated': {
      const keys = Object.keys(p);
      if (keys.length === 1 && keys[0] === 'notes') {
        const last = String(p.notes ?? '').trim().split('\n').at(-1) ?? '';
        return { ...base, kind: 'note', title: 'Board notes changed', detail: str(last, 120) };
      }
      if (keys.join() === 'mode') return { ...base, kind: 'board', title: `Mode: ${p.mode === 'expert' ? 'Expert' : 'Guided'}` };
      return { ...base, kind: 'board', title: `Board details changed: ${str(keys.join(', '))}`, detail: p.device ? str(p.device) : '' };
    }
    case 'asset/added':
      return { ...base, kind: 'photo', title: `Photo added: ${str(e.asset?.label || e.asset?.side || 'photo')}`,
        detail: e.asset?.width ? `${e.asset.width} × ${e.asset.height} px` : '', target: { kind: 'asset', id: e.asset?.id } };
    case 'asset/updated':
      return { ...base, kind: 'photo', title: 'Photo changed', target: { kind: 'asset', id: e.id } };
    case 'asset/removed':
      return { ...base, kind: 'photo', title: 'Photo removed' };
    case 'marker/added':
      return { ...base, kind: 'header', title: `Header marked${e.marker?.label ? `: ${str(e.marker.label)}` : ''}`,
        detail: e.schematic ? `${e.schematic.rows} × ${e.schematic.cols} pins` : '', target: { kind: 'marker', id: e.marker?.id } };
    case 'marker/updated':
      if (p.label !== undefined) return { ...base, kind: 'header', title: `Header labelled ${str(p.label) || '(no label)'}`, target: { kind: 'marker', id: e.id } };
      return null;                                        // moves are noise in a history
    case 'marker/removed':
      return { ...base, kind: 'header', title: 'Header removed' };
    case 'schematic/updated': {
      const what = Object.entries(p).map(([k, v]) => (['rows', 'cols', 'name'].includes(k) ? `${k} ${str(v, 20)}` : k)).join(', ');
      return { ...base, kind: 'header', title: `${header(e.id)} changed`, detail: str(what) };
    }
    case 'pin/readingAdded':
      return describe({ ...e, type: 'pin/updated', patch: { readings: [e.reading] } }, project, playbooks);
    case 'pin/updated': {
      const where = `${header(e.schematicId)} pin ${str(e.index, 4)}`;
      if (e.patch === null) return { ...base, kind: 'header', title: `${where} cleared` };
      const readings = list(p.readings);
      if (readings.length) {
        const r = readings.at(-1) ?? {};
        const power = r.powered === true ? 'powered' : r.powered === false ? 'unpowered' : '';
        return { ...base, kind: 'reading', title: `${where}: ${str(r.text ?? r.value, 20)}`, detail: [r.mode, power].filter(Boolean).join(', ') };
      }
      if (p.guess) return { ...base, kind: 'header', title: `${where}: ${guess} ${str(p.guess.role, 10)} (${str(p.guess.confidence, 10)})`, detail: str(p.guess.evidence, 160) };
      if (p.note !== undefined) return { ...base, kind: 'note', title: `Note on ${where}`, detail: str(String(p.note).trim().split('\n').at(-1), 120) };
      if (p.role !== undefined) return { ...base, kind: 'header', title: p.role ? `${where} is ${str(p.role, 10)}` : `${where} role cleared` };
      return { ...base, kind: 'header', title: `${where} changed` };
    }
    case 'components/replaced':
      return { ...base, kind: 'board', title: `Components replaced (${list(e.components).length})` };
    case 'capture/started':
      if (e.capture?.kind === 'logic') {
        return { ...base, kind: 'console', title: `Logic capture imported: ${str(e.capture.label)}`, detail: `${formatRate(e.capture.samplerate)}, ${str(e.capture.duration, 10)} s`, target: { kind: 'logic', id: e.capture.id } };
      }
      if (e.capture?.kind === 'shell') {
        return { ...base, kind: 'console', title: `Shell session started: ${str(e.capture.label)}`, target: { kind: 'capture', id: e.capture.id, path: e.capture.path } };
      }
      return { ...base, kind: 'console', title: `Console opened: ${str(e.capture?.label || e.capture?.port)}`,
        detail: `${str(e.capture?.baud, 10)} baud`, target: { kind: 'capture', id: e.capture?.id, path: e.capture?.path } };
    case 'capture/stopped': {
      const capture = list(project?.captures).find((c) => c.id === e.id);
      const why = p.reason && p.reason !== 'closed' ? ` (${str(p.reason, 60)})` : '';
      const what = capture?.kind === 'shell' ? 'Shell session ended' : 'Console closed';
      return { ...base, kind: 'console', title: `${what}, ${bytes(p.bytes) || 'nothing'} captured${why}`,
        target: capture?.path ? { kind: 'capture', id: e.id, path: capture.path } : undefined };
    }
    case 'capture/updated':
      if (Array.isArray(p.decoded) && p.decoded.length) {
        return { ...base, kind: 'console', title: `Decoded UART: ${p.decoded.map((d) => `${str(d.name, 8)} at ${str(d.baud, 8)} baud`).join(', ')}`,
          detail: p.decoded.map((d) => `${d.bytes} bytes${d.errors ? `, ${d.errors} errors` : ''}`).join('; '), target: { kind: 'logic', id: e.id } };
      }
      if (p.compare) {
        return { ...base, kind: 'console', title: `Compared with the console capture: ${Math.round((p.compare.ratio ?? 0) * 100)}% the same`, target: { kind: 'logic', id: e.id } };
      }
      return null;                                        // detection progress; the playbook checks show it
    case 'annotation/added':
      if (e.annotation?.guess) {
        return { ...base, kind: 'note', title: `${guess}: ${str(e.annotation.text)} (${str(e.annotation.guess.confidence, 10)})`,
          detail: str(e.annotation.guess.evidence, 160), target: { kind: 'callout', id: e.annotation.id } };
      }
      return { ...base, kind: 'note', title: `Callout added${e.annotation?.text ? `: ${str(e.annotation.text)}` : ''}`, target: { kind: 'callout', id: e.annotation?.id } };
    case 'annotation/updated':
      if ('guess' in p && p.guess === null) return { ...base, kind: 'note', title: 'Callout checked', target: { kind: 'callout', id: e.id } };
      return p.text !== undefined ? { ...base, kind: 'note', title: `Callout: ${str(p.text)}`, target: { kind: 'callout', id: e.id } } : null;
    case 'annotation/removed':
      return { ...base, kind: 'note', title: 'Callout removed' };
    case 'playbook/updated': {
      const target = { kind: 'playbook', playbookId: e.playbookId, stepId: e.stepId };
      const where = e.stepId ? `${playbookTitle(e.playbookId)}: ${stepTitle(e.playbookId, e.stepId)}` : playbookTitle(e.playbookId);
      if ('done' in p) return { ...base, kind: 'playbook', title: p.done ? `Step done: ${str(where, 100)}` : `Step reopened: ${str(where, 100)}`, target };
      if (p.answers) {
        const answers = Object.values(p.answers).filter(Boolean).map((v) => str(v, 30)).join(', ');
        return { ...base, kind: 'playbook', title: `Answered: ${str(where, 100)}`, detail: answers, target };
      }
      return null;                                        // ticking safety points is not history
    }
    default:
      return null;
  }
}

/** All entries, newest first. Commits are merged in by date. */
export function buildTimeline({ events = [], project = null, commits = [], playbooks = [], guess = 'AI guess' } = {}) {
  const entries = [];
  for (const event of list(events)) {
    const entry = describe(event, project, playbooks, guess);
    if (entry) entries.push(entry);
  }
  for (const c of list(commits)) {
    if (!c || typeof c !== 'object') continue;
    entries.push({ kind: 'commit', ts: c.date, title: `Committed: ${str(c.subject, 100)}`, detail: String(c.hash ?? '').slice(0, 10) });
  }
  const time = (entry) => { const t = Date.parse(entry.ts); return Number.isNaN(t) ? 0 : t; };
  return entries.sort((a, b) => time(b) - time(a) || (b.seq ?? 0) - (a.seq ?? 0));
}

/** Group entries by local calendar day, keeping order: [{ day: 'Sunday 25 October 2026', entries }]. */
export function byDay(entries) {
  const groups = [];
  for (const entry of entries) {
    const date = new Date(entry.ts);
    const day = Number.isNaN(date.getTime()) ? 'Unknown date'
      : date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (groups.at(-1)?.day !== day) groups.push({ day, entries: [] });
    groups.at(-1).entries.push(entry);
  }
  return groups;
}
