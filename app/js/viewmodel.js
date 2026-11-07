// Plain-language descriptions of state, kept free of the DOM so they can be tested.

export function summarize(project) {
  if (!project) return null;
  return {
    name: project.meta?.name || 'Untitled board',
    device: project.meta?.device || '',
    notes: project.meta?.notes || '',
    modified: project.meta?.modified || '',
  };
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

const SAVED_TITLE = 'Every change is saved in the board folder.';
const pad = (n) => String(n).padStart(2, '0');

/**
 * What the status chip shows: {text, state, title}. A missing connection or a reconnect comes first, then
 * the save state. `saving` is true once a write has been in flight long enough to be worth showing.
 */
export function chipModel({ status, error, save }, saving = false) {
  if (status !== 'live') return { text: statusLabel(status), state: status, title: error?.message ?? '' };
  if (save?.pending > 0 && saving) return { text: 'Saving', state: 'saving', title: '' };
  if (save?.error) return { text: 'Not saved', state: 'unsaved', title: save.error };
  if (save?.at !== null && save?.at !== undefined) {
    const time = new Date(save.at);
    return { text: `Saved ${pad(time.getHours())}:${pad(time.getMinutes())}`, state: 'saved', title: SAVED_TITLE };
  }
  return { text: 'Saved', state: 'saved', title: SAVED_TITLE };
}

/** The time of a commit: the clock time on the same day, the date and time otherwise. */
export function commitTime(iso, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso ?? '');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return day(date) === day(now) ? time : `${day(date)} ${time}`;
}

/** A time like 16:02:11; falls back to the raw text for anything unparseable. */
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
