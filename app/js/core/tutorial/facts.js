// What the tutorial knows about the learner's work, as plain data. Pure: it reads the project and a few
// view facts and gives back an object the lessons check. The bench and console facts of later chapters
// are passed in as `extra` and merged in.

// J4 on the practice photo, in photo pixels (the coordinates demo.py uses for its UART header).
export const J4 = { x: 280, y: 750, w: 117, h: 40 };

export const centreInside = (marker, rect = J4) => {
  const x = marker.x + (marker.w ?? 0) / 2;
  const y = marker.y + (marker.h ?? 0) / 2;
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
};

// A console session that stopped the countdown differs from the capture, whose countdown ran out, so a good
// comparison is about 0.85, not 1. A recording made at the wrong speed scores near 0.
const MATCH_RATIO = 0.8;

/** What the logic capture on the board says about the work: persisted by the service, so it survives a reload. */
function logicFacts(project) {
  const capture = (project?.captures ?? []).find((c) => c.kind === 'logic') ?? null;
  const decoded = (capture?.decoded ?? []).find((d) => d.baud === 115200 && d.bytes >= 20 && !d.errors) ?? null;
  const ratio = typeof capture?.compare?.ratio === 'number' ? capture.compare.ratio : null;
  return {
    decoded115200: Boolean(decoded),
    decodedBaud: capture?.decoded?.at(-1)?.baud ?? 0,
    compareRatio: ratio,
    compareMatches: ratio !== null && ratio >= MATCH_RATIO,
    consoleCaptures: (project?.captures ?? []).filter((c) => c.kind === 'serial' || c.kind === 'shell').length,
  };
}

export function buildFacts({ project, zoomed = false, extra = {} } = {}) {
  const markers = project?.markers ?? [];
  const schematics = project?.schematics ?? [];
  const header = markers.find((m) => m.shape === 'box' && centreInside(m)) ?? null;
  const schematic = header ? schematics.find((s) => s.id === header.schematicId) ?? null : null;
  const role = (index) => schematic?.pins?.find((p) => p.index === index)?.role ?? '';
  const roles = [1, 2, 3, 4].map(role);
  return {
    zoomed,
    markerCount: markers.length,
    header,
    schematic,
    label: header?.label ?? '',
    rows: schematic?.rows ?? 0,
    cols: schematic?.cols ?? 0,
    roles,
    groundPins: schematic ? schematic.pins.filter((p) => p.role === 'GND').map((p) => p.index) : [],
    headerName: schematic?.name ?? '',
    notes: schematic?.notes ?? '',
    ...logicFacts(project),
    ...extra,
  };
}
