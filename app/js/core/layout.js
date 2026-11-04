// Where panels live: four regions, each a stack or a tab group, plus panels detached to their own
// windows and panels the person put away. A panel is in exactly one of those places. A layout is plain
// data so it can be saved as a workspace, sent to the desktop shell and tested in Node. Every operation
// returns a new layout; nothing is changed in place.

export const PANELS = {
  board: 'Board',
  inspector: 'Header',
  feed: 'Changes',
  photo: 'Photo',
  playbook: 'Playbook',
  wiki: 'Wiki',
  console: 'Console',
  timeline: 'Timeline',
  logic: 'Logic',
  terminal: 'Terminal',
  assistant: 'Agent',
};
export const REGIONS = ['left', 'center', 'right', 'bottom'];
const MODES = ['tabs', 'stack'];

const DETACHED_IN_WALL = ['console', 'playbook', 'timeline', 'board', 'feed', 'wiki', 'terminal', 'logic', 'assistant'];

const learn = {
  regions: { left: ['board', 'inspector', 'feed'], center: ['photo'], right: ['playbook', 'wiki', 'console', 'timeline', 'logic', 'terminal', 'assistant'], bottom: [] },
  active: { left: 'board', center: 'photo', right: 'playbook', bottom: null },
  modes: { left: 'stack', center: 'tabs', right: 'tabs', bottom: 'tabs' },
  detached: [],
  away: [],
  origins: {},
};

/** Where Learn keeps each panel, so a preset's windows return their panels to a sensible place. */
function originsOf(panels) {
  const origins = {};
  for (const panel of panels) {
    const region = REGIONS.find((r) => learn.regions[r].includes(panel));
    origins[panel] = { region, index: learn.regions[region].indexOf(panel) };
  }
  return origins;
}

export const PRESETS = {
  Learn: learn,
  Console: {
    regions: { left: ['inspector', 'feed'], center: ['console', 'photo', 'terminal'], right: ['playbook', 'wiki', 'timeline', 'logic', 'assistant'], bottom: [] },
    active: { left: 'inspector', center: 'console', right: 'playbook', bottom: null },
    modes: { left: 'stack', center: 'tabs', right: 'tabs', bottom: 'tabs' },
    detached: ['board'],
    away: [],
    origins: originsOf(['board']),
  },
  Analysis: {
    regions: { left: ['board', 'feed'], center: ['timeline', 'logic', 'photo'], right: ['wiki', 'playbook', 'assistant'], bottom: ['terminal', 'console'] },
    active: { left: 'board', center: 'timeline', right: 'wiki', bottom: 'terminal' },
    modes: { left: 'stack', center: 'tabs', right: 'tabs', bottom: 'tabs' },
    detached: ['inspector'],
    away: [],
    origins: originsOf(['inspector']),
  },
  Wall: {
    regions: { left: ['inspector'], center: ['photo'], right: [], bottom: [] },
    active: { left: 'inspector', center: 'photo', right: null, bottom: null },
    modes: { left: 'stack', center: 'tabs', right: 'tabs', bottom: 'tabs' },
    detached: DETACHED_IN_WALL,
    away: [],
    origins: originsOf(DETACHED_IN_WALL),
  },
};

/** The Agent panel does not exist while the assistant is off, so no region, tab or window holds it. */
function withoutAssistant(layout) {
  for (const region of REGIONS) {
    layout.regions[region] = layout.regions[region].filter((p) => p !== 'assistant');
    if (layout.active[region] === 'assistant') layout.active[region] = layout.regions[region][0] ?? null;
  }
  layout.detached = layout.detached.filter((p) => p !== 'assistant');
  layout.away = layout.away.filter((p) => p !== 'assistant');
  delete layout.origins.assistant;
  return layout;
}

const clone = (layout) => ({ origins: {}, away: [], ...JSON.parse(JSON.stringify(layout)) });

/** Where a panel is: { region, index }, { detached: true } (own window), { away: true } or null. */
export function locate(layout, panel) {
  if (layout.detached.includes(panel)) return { detached: true };
  if (layout.away?.includes(panel)) return { away: true };
  for (const region of REGIONS) {
    const index = layout.regions[region].indexOf(panel);
    if (index !== -1) return { region, index };
  }
  return null;
}

/**
 * Repair anything loaded from disk or an older version: unknown panels are dropped, missing ones
 * go to the right-hand tabs, duplicates are removed, active tabs point at panels that are there.
 */
export function normalize(raw, { assistant = 'on' } = {}) {
  const off = assistant === 'off';
  const base = off ? withoutAssistant(clone(learn)) : clone(learn);
  if (!raw || typeof raw !== 'object' || !raw.regions || typeof raw.regions !== 'object') return base;
  const input = raw;
  const seen = new Set(off ? ['assistant'] : []);       // seen from the start, so it is dropped wherever it was
  const take = (list) => (Array.isArray(list) ? list : []).filter((p) => p in PANELS && !seen.has(p) && seen.add(p));
  const layout = { regions: {}, active: {}, modes: {}, detached: [], away: [], origins: {} };
  for (const region of REGIONS) layout.regions[region] = take(input.regions?.[region]);
  layout.detached = take(input.detached);
  layout.away = take(input.away);
  for (const panel of Object.keys(PANELS)) {
    if (!seen.has(panel)) { layout.regions.right.push(panel); seen.add(panel); }
  }
  // Where each detached or put-away panel came from, so closing its window or showing it puts it back there.
  for (const panel of [...layout.detached, ...layout.away]) {
    const origin = input.origins?.[panel];
    if (origin && REGIONS.includes(origin.region) && Number.isInteger(origin.index) && origin.index >= 0) {
      layout.origins[panel] = { region: origin.region, index: origin.index };
    }
  }
  for (const region of REGIONS) {
    const mode = input.modes?.[region];
    layout.modes[region] = MODES.includes(mode) ? mode : base.modes[region];
    const active = input.active?.[region];
    layout.active[region] = layout.regions[region].includes(active) ? active : layout.regions[region][0] ?? null;
  }
  return layout;
}

function remove(layout, panel) {
  const next = clone(layout);
  for (const region of REGIONS) {
    next.regions[region] = next.regions[region].filter((p) => p !== panel);
    if (next.active[region] === panel) next.active[region] = next.regions[region][0] ?? null;
  }
  next.detached = next.detached.filter((p) => p !== panel);
  next.away = next.away.filter((p) => p !== panel);
  delete next.origins[panel];
  return next;
}

/** Take a panel out of the place it is in and file it under `list`, keeping the origin it will return to. */
function relocate(layout, panel, list) {
  if (!(panel in PANELS) || layout[list].includes(panel)) return layout;
  const where = locate(layout, panel);
  const origin = where?.region ? { region: where.region, index: where.index } : layout.origins?.[panel];
  const next = remove(layout, panel);
  next[list].push(panel);
  if (origin) next.origins[panel] = origin;
  return next;
}

/** Put a panel into a region at an index (end by default) and make it the active tab there. */
export function move(layout, panel, region, index = Infinity) {
  if (!(panel in PANELS) || !REGIONS.includes(region)) return layout;
  const next = remove(layout, panel);
  const list = next.regions[region];
  list.splice(Math.max(0, Math.min(index, list.length)), 0, panel);
  next.active[region] = panel;
  return next;
}

/** Bring a panel to the front of its region. Detached panels stay detached. */
export function activate(layout, panel) {
  const where = locate(layout, panel);
  if (!where?.region) return layout;
  const next = clone(layout);
  next.active[where.region] = panel;
  return next;
}

/** Send a panel to its own window. A panel that is already detached keeps the origin it will return to. */
export function detach(layout, panel) {
  return relocate(layout, panel, 'detached');
}

/** Put a panel away: out of every region and window, until the person shows it again. */
export function putAway(layout, panel) {
  return relocate(layout, panel, 'away');
}

/** Bring a detached or put-away panel back: to `region` if given, else to where it came from, else the right. */
export function attach(layout, panel, region) {
  const origin = layout.origins?.[panel];
  const target = REGIONS.includes(region) ? region : origin?.region ?? 'right';
  const index = !REGIONS.includes(region) && origin ? origin.index : Infinity;
  return move(layout, panel, target, index);
}

export function setMode(layout, region, mode) {
  if (!REGIONS.includes(region) || !MODES.includes(mode)) return layout;
  const next = clone(layout);
  next.modes[region] = mode;
  return next;
}

/** Panels on screen in the main window, per region, with what is shown. */
export function visiblePanels(layout, { assistant = 'on' } = {}) {
  const shown = new Set();
  for (const region of REGIONS) {
    const list = layout.regions[region];
    if (layout.modes[region] === 'stack') list.forEach((p) => shown.add(p));
    else if (layout.active[region]) shown.add(layout.active[region]);
  }
  if (assistant === 'off') shown.delete('assistant');
  return shown;
}

const TUTORIAL_REGION = { board: 'left', inspector: 'left', photo: 'center', console: 'center', logic: 'center', wiki: 'center' };

/**
 * The fixed layout of the tutorial for the panels a step needs: the Wiki always sits beside them in the
 * centre so a "Read more" link has somewhere to open. Everything else is put away. Never saved as a workspace.
 */
export function tutorialLayout(panels) {
  const wanted = [...new Set([...panels, 'wiki'])].filter((p) => p in TUTORIAL_REGION);
  const layout = { regions: { left: [], center: [], right: [], bottom: [] }, active: { left: null, center: null, right: null, bottom: null },
    modes: { left: 'stack', center: 'tabs', right: 'tabs', bottom: 'tabs' }, detached: [], away: [], origins: {} };
  for (const panel of wanted) layout.regions[TUTORIAL_REGION[panel]].push(panel);
  layout.away = Object.keys(PANELS).filter((p) => !wanted.includes(p));
  for (const region of REGIONS) layout.active[region] = layout.regions[region][0] ?? null;
  return layout;
}
