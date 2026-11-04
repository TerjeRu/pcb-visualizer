// The Logic panel: import a logic analyzer capture (.sr from PulseView or sigrok-cli, or sigrok CSV),
// look at the channels, decode UART and compare the result with a console capture of the same boot.
// The service sends level changes for the visible window only, never the raw samples. Decoded text
// is untrusted device output and is only set with textContent.

import { readTokens } from './tokens.js';
import { dom } from './dom.js';
import { formatRate } from './core/format.js';

const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const ROW = 34;           // pixels per channel row
const LABEL = 46;         // pixels for channel names

/** A serial capture is named by its speed, so two recordings from one port can be told apart. */
const consoleName = (x) => (x.kind === 'serial' && Number.isFinite(x.baud) ? `Console at ${x.baud} baud` : (x.label ?? x.kind));

export function createLogicView(doc, handlers, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) }) {
  const { $, options, screenRows } = dom(doc);

  let project = null;
  let editable = false;
  let captureId = null;
  let view = { start: 0, end: 0 };      // visible samples
  let data = null;                      // last edges response
  let fetchTimer = null;
  let drag = null;
  let generation = 0;                   // bumped by reset(), so answers for the previous board are dropped

  const captures = () => (project?.captures ?? []).filter((c) => c.kind === 'logic');
  const current = () => captures().find((c) => c.id === captureId) ?? null;

  options($('logic-baud'), [{ value: '', label: 'Auto speed' }, ...BAUDS.map((b) => ({ value: String(b), label: `${b} baud` }))]);
  $('logic-capture').addEventListener('change', (event) => select(event.target.value));
  $('logic-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const started = generation;
    let samplerate = '';
    if (!/\.sr$/i.test(file.name)) samplerate = doc.defaultView?.prompt?.('If the CSV does not give the sample rate, enter it (for example 1 MHz):', '') ?? '';
    status(`Importing ${file.name}…`);
    const result = await handlers.importLogic(file, file.name, samplerate);
    if (started !== generation) return;
    if (result?.capture) {
      const found = result.capture.decoded?.map((d) => `${d.name} at ${d.baud} baud`).join(', ');
      status(found ? `Imported. Found UART on ${found}.` : 'Imported. The app found no UART. Choose a channel and a speed to decode.');
      select(result.capture.id);
    } else status('');
  });
  $('logic-zoom-in').addEventListener('click', () => zoom(0.5));
  $('logic-zoom-out').addEventListener('click', () => zoom(2));
  $('logic-zoom-fit').addEventListener('click', () => { const c = current(); if (c) setView(0, c.samples); });
  $('logic-decode').addEventListener('click', decode);
  $('logic-compare').addEventListener('click', compare);
  $('logic-ask').addEventListener('click', () => {
    const c = current();
    if (c) handlers.onAsk?.('What does this logic capture show, and what should I check next?', { capture: c.id, channel: Number($('logic-channel').value) });
  });

  function status(text) { $('logic-status').textContent = text; }

  function setView(start, end) {
    const c = current();
    if (!c) return;
    const span = Math.round(Math.max(50, Math.min(c.samples, end - start)));
    start = Math.max(0, Math.min(Math.round(start), c.samples - span));
    view = { start, end: start + span };
    drawAxis();
    timers.clear(fetchTimer);
    fetchTimer = timers.set(fetchEdges, 80);
  }

  function zoom(factor, anchor = 0.5) {
    const span = view.end - view.start;
    const center = view.start + span * anchor;
    const next = span * factor;
    setView(center - next * anchor, center - next * anchor + next);
  }

  async function fetchEdges() {
    const c = current();
    if (!c) return;
    const wanted = { ...view };
    const started = generation;
    try {
      const columns = Math.max(100, Math.round((canvas.parentElement?.clientWidth || 600) - LABEL));
      const result = await handlers.logicEdges(c.id, wanted.start, wanted.end, columns);
      if (started === generation && captureId === c.id && wanted.start === view.start && wanted.end === view.end) {
        data = result;
        drawWave();
      }
    } catch (error) {
      if (started === generation) status(`Could not load the waveform: ${error.message}`);
    }
  }

  const canvas = $('logic-canvas');
  canvas.addEventListener('wheel', (event) => {
    if (!current()) return;
    event.preventDefault();
    const box = canvas.getBoundingClientRect();
    const anchor = Math.min(1, Math.max(0, (event.clientX - box.left - LABEL) / Math.max(1, box.width - LABEL)));
    zoom(event.deltaY > 0 ? 1.5 : 1 / 1.5, anchor);
  }, { passive: false });
  canvas.addEventListener('pointerdown', (event) => {
    if (!current()) return;
    drag = { x: event.clientX, start: view.start, end: view.end };
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const width = Math.max(1, canvas.getBoundingClientRect().width - LABEL);
    const shift = ((drag.x - event.clientX) / width) * (drag.end - drag.start);
    setView(drag.start + shift, drag.end + shift);
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('pointercancel', () => { drag = null; });

  function seconds(samples) {
    const c = current();
    const s = samples / (c?.samplerate || 1);
    return s >= 1 ? `${s.toFixed(3)} s` : s >= 1e-3 ? `${(s * 1e3).toFixed(3)} ms` : `${(s * 1e6).toFixed(1)} µs`;
  }

  function drawAxis() {
    const c = current();
    $('logic-window').textContent = c ? `${seconds(view.start)} to ${seconds(view.end)} (${seconds(view.end - view.start)} shown)` : '';
  }

  function drawWave() {
    const c = current();
    const ctx = canvas.getContext?.('2d');
    if (!ctx || !c) return;
    const channels = c.channels;
    const width = Math.max(300, canvas.parentElement?.clientWidth || 600);
    const height = channels.length * ROW + 8;
    const ratio = doc.defaultView?.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const tokens = readTokens(doc.defaultView, canvas, ['--scr-fg', '--scr-line', '--scr-bg', '--scr-warn']);
    const fg = tokens['--scr-fg'], dim = tokens['--scr-line'], warn = tokens['--scr-warn'];
    ctx.fillStyle = tokens['--scr-bg'];
    ctx.fillRect(0, 0, width, height);
    const decodedChannels = new Set((c.decoded ?? []).map((d) => d.channel));
    const x = (sample) => LABEL + ((sample - view.start) / Math.max(1, view.end - view.start)) * (width - LABEL);
    ctx.font = '11px "JetBrainsMono Nerd Font", monospace';
    channels.forEach((name, ch) => {
      const top = 4 + ch * ROW;
      const high = top + 6, low = top + ROW - 10;
      ctx.fillStyle = decodedChannels.has(ch) ? warn : fg;
      ctx.fillText(name, 4, top + ROW / 2 + 3);
      ctx.strokeStyle = dim;
      ctx.beginPath(); ctx.moveTo(LABEL, top + ROW - 2); ctx.lineTo(width, top + ROW - 2); ctx.stroke();
      const summary = data?.bins?.[ch] ?? data?.bins?.[String(ch)];
      if (summary) {
        // A busy window: one character per screen column, 0 low, 1 high, 2 changing (drawn as a band).
        const colour = decodedChannels.has(ch) ? warn : fg;
        const step = (width - LABEL) / summary.length;
        ctx.strokeStyle = colour;
        ctx.fillStyle = colour;
        ctx.beginPath();
        for (let i = 0; i < summary.length; i++) {
          const px = LABEL + i * step;
          if (summary[i] === '2') ctx.fillRect(px, high, Math.max(1, step), low - high);
          else { const y = summary[i] === '1' ? high : low; ctx.moveTo(px, y); ctx.lineTo(px + step, y); }
        }
        ctx.stroke();
        return;
      }
      const changes = data?.edges?.[ch] ?? data?.edges?.[String(ch)] ?? [];
      if (!changes.length) return;
      ctx.strokeStyle = decodedChannels.has(ch) ? warn : fg;
      ctx.beginPath();
      let level = changes[0][1];
      ctx.moveTo(LABEL, level ? high : low);
      for (const [sample, next] of changes.slice(1)) {
        const px = x(sample);
        ctx.lineTo(px, level ? high : low);
        ctx.lineTo(px, next ? high : low);
        level = next;
      }
      ctx.lineTo(width, level ? high : low);
      ctx.stroke();
    });
    if (data?.truncated) {
      ctx.fillStyle = warn;
      ctx.fillText('Too many edges to draw. Zoom in.', LABEL + 8, height - 6);
    }
  }

  function drawDecoded(text) {
    $('logic-text').replaceChildren(...screenRows(text));
  }

  async function decode() {
    const c = current();
    if (!c) return;
    const channel = Number($('logic-channel').value);
    const baud = Number($('logic-baud').value) || 0;
    status('Decoding…');
    const started = generation;
    const result = await handlers.logicDecode(c.id, channel, baud);
    if (started !== generation) return;
    if (!result) { status(''); return; }
    const d = result.decoded;
    status(`${d.name} at ${d.baud} baud: ${d.bytes} bytes${d.errors ? `, ${d.errors} framing errors (the speed may be wrong)` : ''}.`);
    drawDecoded(result.preview);
  }

  async function compare() {
    const c = current();
    const other = $('logic-compare-with').value;
    if (!c || !other) return;
    const started = generation;
    const result = await handlers.logicCompare(c.id, Number($('logic-channel').value), other);
    if (!result || started !== generation) return;
    drawCompare(result.compare);
  }

  function drawCompare(comparison) {
    const box = $('logic-compare-result');
    if (!comparison) { box.textContent = ''; return; }
    const percent = Math.floor(comparison.ratio * 1000) / 10;      // 99.9, never rounded up to 100 with a difference
    let text = comparison.first_difference && percent >= 99
      ? `Almost identical to the console capture (${percent}%).`
      : `${percent}% the same as the console capture.`;
    if (comparison.first_difference) {
      const f = comparison.first_difference;
      text += ` First difference on line ${f.line}: decoded "${f.decoded}", console "${f.console}".`;
    } else if (percent >= 95) text += ' The analyzer and the console saw the same boot.';
    box.textContent = text;
  }

  async function loadDecodedText(c) {
    const decoded = (c.decoded ?? []).find((d) => d.channel === Number($('logic-channel').value)) ?? c.decoded?.[0];
    if (!decoded) { $('logic-text').replaceChildren(); return; }
    const started = generation;
    try {
      const text = await handlers.loadCaptureLog(decoded.text);
      if (started === generation) drawDecoded(text);
    } catch { /* the text file can be missing in an old board */ }
  }

  function select(id) {
    captureId = id || null;
    const c = current();
    handlers.noteLogic?.({ open: Boolean(c) });
    data = null;
    drawControls();
    if (!c) return;
    $('logic-channel').value = String(c.decoded?.[0]?.channel ?? 0);
    setView(0, c.samples);
    loadDecodedText(c);
    drawCompare(c.compare);
  }

  function consoleCaptures() { return (project?.captures ?? []).filter((x) => x.kind === 'serial' || x.kind === 'shell'); }

  function drawControls() {
    const list = captures();
    const box = $('logic-capture');
    options(box, (list.length ? list : [{ id: '', label: 'No logic captures yet' }]).map((c) => ({ value: c.id, label: c.label ?? c.id, selected: c.id === captureId })));
    box.hidden = list.length === 0;
    const c = current();
    $('logic-empty').hidden = Boolean(c);
    $('logic-body').hidden = !c;
    $('logic-import').classList.toggle('disabled', !editable);
    $('logic-file').disabled = !editable;
    if (!c) return;
    $('logic-info').textContent = `${formatRate(c.samplerate)}, ${c.duration} s, ${c.channels.length} channels. ${(c.decoded ?? []).map((d) => `UART on ${d.name} at ${d.baud} baud`).join('; ')}`;
    const channelSelect = $('logic-channel');
    const keep = channelSelect.value;
    options(channelSelect, c.channels.map((name, i) => ({ value: String(i), label: name })));
    if (keep) channelSelect.value = keep;
    const consoles = consoleCaptures();
    options($('logic-compare-with'), [{ id: '', label: 'Compare with a console capture…' }, ...consoles.slice().reverse()].map((x) => ({
      value: x.id,
      label: x.id ? `${consoleName(x)} (${x.started?.slice(0, 16).replace('T', ' ') ?? ''})` : x.label,
    })));
    for (const id of ['logic-decode', 'logic-compare']) $(id).disabled = !editable;
  }

  return {
    render(nextProject, isEditable) {
      const key = () => `${captures().map((c) => c.id).join()}|${consoleCaptures().map((c) => c.id).join()}`;
      const before = key();
      project = nextProject;
      editable = isEditable;
      if (!captureId && captures().length) { select(captures().at(-1).id); return; }
      if (key() !== before) drawControls();
      const c = current();
      if (c) { drawCompare(c.compare); const info = $('logic-info'); if (info && !info.textContent) drawControls(); }
    },
    /** Show a capture, for example from the timeline. */
    focus(id) { select(id); },
    shown() { if (data) drawWave(); },
    reset() {
      generation += 1;
      timers.clear(fetchTimer);
      captureId = null; data = null; project = null; drag = null;
      status('');
      $('logic-text').replaceChildren();
    },
  };
}
