// What the Board panel has selected and where it is looking. View state only: it never leaves the panel.

export function createBoardState() {
  const s = {
    project: null,
    editable: false,
    assetId: null,
    markerId: null,
    calloutId: null,            // a callout is selected instead of a marker, never both
    pinIndex: null,
    tool: 'select',
    zoom: null,                 // null = fit to the stage
    shownPath: null,
    drag: null,
    preview: null,              // { id, patch } while a callout is dragged
    pendingCallout: null,       // just placed; keep it selected until its event arrives
    generation: 0,              // bumped by reset(), so answers for the previous board are dropped
  };
  s.asset = () => s.project?.assets.find((a) => a.id === s.assetId) ?? null;
  s.marker = () => s.project?.markers.find((m) => m.id === s.markerId) ?? null;
  s.callout = () => s.project?.annotations?.find((c) => c.id === s.calloutId) ?? null;
  s.schematic = () => {
    const m = s.marker();
    return m ? s.project.schematics.find((x) => x.id === m.schematicId) ?? null : null;
  };
  s.select = ({ marker = null, callout = null } = {}) => { s.markerId = marker; s.calloutId = callout; s.pinIndex = null; };
  return s;
}
