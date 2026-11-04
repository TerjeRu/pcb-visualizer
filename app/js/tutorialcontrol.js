// The tutorial's controller: it starts and leaves the tutorial, keeps the step, builds the facts the
// lessons check and decides which changes go through. The controller hands it the few things it needs
// (the service calls, the view, board selection) so this file stays free of the DOM. The rules and the text
// are in core/tutorial/; what is drawn is in tutorialview.js and ui.js.

import { LAST_STEP, TOTAL_STEPS, benchSetup, consoleSetup, finishLines, lesson, setupEvents, stepDone } from './core/tutorial/lessons.js';
import { createConsoleFacts, factsFromRecordings } from './core/tutorial/consolefacts.js';
import { ADAPTER_LINES, BENCH_PINS, createBench, benchFacts } from './core/tutorial/bench.js';
import { buildFacts } from './core/tutorial/facts.js';
import { REFUSED, allowed, allowedAction } from './core/tutorial/policy.js';

export const TUTORIAL_SLUG = 'pcbv-tutorial';
const RUNNING_KEY = 'pcbv.tutorial';
const clampStep = (value) => (Number.isInteger(value) && value >= 1 && value <= TOTAL_STEPS ? value : 1);

export const CLEANUP_MS = 3000;           // how long leaving waits for the service to close the console and stop the virtual board
export const REPLAY_RECORDINGS = 20;      // the newest console recordings read back when the tutorial starts
export const REPLAY_BYTES = 262144;       // and how much of each
const FLASH_ANSWER_NOTE = 'Correct. 25Q128 is a 16 MiB SPI flash chip. It holds U-Boot, Linux and the settings.';

const TICK_MS = 250;     // how often the meter redraws while pin 2 is jumpy

export function createTutorialControl({ api, view, hooks, storage, lastStep = LAST_STEP, benchOptions = {}, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) } }) {
  let active = false;
  let busy = false;
  let step = 1;
  let before = null;              // the board that was open when the tutorial started
  let zoomed = false;
  let latest = null;              // the practice board's latest client state
  let facts = buildFacts({});
  let setupFor = null;            // the step whose setup events have been sent
  let settingUp = false;
  let page = null;                // 'finish' or 'end' while the closing page shows
  let extra = () => ({});         // bench and console facts of later chapters
  let generation = 0;             // raised on every start and leave, so an answer for an earlier run is dropped
  let bench = createBench(benchOptions);
  let tick = null;                // the timer that redraws the meter while it is jumpy
  const consoleFacts = createConsoleFacts();
  let logicOpen = false;          // the Logic panel shows the practice capture
  let exported = false;           // a report was exported from the practice board
  let startedVdev = false;        // this tutorial started the virtual board, so it stops it
  let flashAnswer = null;         // the chip chosen on step 12; asked again after a reload
  let replayed = false;           // the board's console recordings were read for this run

  const remember = (on) => { try { if (on) storage?.setItem(RUNNING_KEY, '1'); else storage?.removeItem(RUNNING_KEY); } catch { /* optional */ } };
  const wasRunning = () => { try { return storage?.getItem(RUNNING_KEY) === '1'; } catch { return false; } };

  async function save(patch) {
    try { await hooks.saveSetting(patch); } catch (error) { hooks.failed(error, 'Could not save your place in the tutorial. Try again.'); }
  }

  function model(moved) {
    const current = lesson(step);
    const done = new Set(current.check(facts));
    return {
      kind: 'step', moved, step, total: TOTAL_STEPS, chapter: current.chapter, title: current.title, body: current.body,
      tasks: current.tasks.map((task) => ({ ...task, done: done.has(task.id) })), hint: current.hint(facts),
      canContinue: stepDone(step, facts), canBack: step > 1, last: step === TOTAL_STEPS, why: current.why, wiki: current.wiki, example: current.example,
      bench: benchModel(), question: questionModel(current),
      // The control the next open task needs, or Continue once the step is done. The coach rings it.
      target: stepDone(step, facts) ? 'tutorial-continue' : current.target(facts),
    };
  }

  function questionModel(current) {
    if (!current.question) return null;
    return { legend: current.question.legend, choices: current.question.choices, chosen: flashAnswer, enabled: Boolean(facts.sawFlash) };
  }

  /** What the meter or the wiring widget needs to draw, or null when the step has no bench. */
  function benchModel() {
    const kind = lesson(step).bench ?? null;
    if (!kind) return null;
    // The virtual board is offered on its first step, and again later only if it is not running (after Back, or a resume).
    if (kind === 'vdev') return step === 10 || !facts.vdevRunning ? { kind, running: Boolean(facts.vdevRunning) } : null;
    const state = bench.state();
    if (kind === 'meter') return { kind, powered: state.powered, mode: state.mode, probe: state.probe, reading: bench.read(), pins: BENCH_PINS };
    return { kind, wiring: state.wiring, lines: ADAPTER_LINES, pins: BENCH_PINS.map((pin) => ({ pin, role: facts.roles?.[pin - 1] ?? '' })) };
  }

  function stopTick() {
    if (tick !== null) timers.clear(tick);
    tick = null;
  }

  /** While pin 2 is jumpy the meter redraws on its own, without redrawing the rest of the step. */
  function scheduleTick() {
    if (tick !== null || !active || lesson(step).bench !== 'meter' || !bench.settling()) return;
    const started = generation;
    tick = timers.set(() => {
      tick = null;
      if (started !== generation || !active) return;
      view.tutorialBench(benchModel());
      scheduleTick();
    }, TICK_MS);
  }

  function renderBench() {
    if (!active || page) return;
    view.tutorialBench(benchModel());
    scheduleTick();
  }

  const currentFacts = () => buildFacts({ project: latest?.project, zoomed, extra: { ...benchFacts(bench), ...consoleFacts.facts(), captureOpen: logicOpen, exported, flashAnswer, ...extra() } });

  /** Something the Console, Logic or Export view reported: draw again only when a fact changed. */
  function reported() {
    if (!active || page) return;
    const before = JSON.stringify(facts);
    if (JSON.stringify(currentFacts()) !== before) render();
  }

  function render(moved = false) {
    if (!active) return;
    facts = currentFacts();
    if (page === 'finish') {
      view.tutorialDraw({ kind: 'finish', target: null, moved, complete: true, step, total: TOTAL_STEPS, chapter: 4, title: 'You found the UART',
        lead: 'In about twenty minutes you went from an unlabelled header on a photo to a shell on the board. You checked it with a second instrument.',
        lines: finishLines(facts),
        where: 'Your practice board stays on this computer, separate from your own boards. To rebuild it, start the tutorial again from Settings.' });
    } else if (page === 'end') {
      view.tutorialDraw({ kind: 'finish', target: null, moved, complete: false, step, total: TOTAL_STEPS, chapter: lesson(step).chapter, title: 'That is all for now',
        lead: 'The next chapters arrive in the next update. Your place is saved. When they are there, resume from Settings.',
        lines: finishLines(facts), where: '' });
    } else {
      view.tutorialDraw(model(moved));
      scheduleTick();
    }
  }

  async function ensureSetup() {
    if (!active || settingUp || setupFor === step || latest?.status !== 'live' || !latest.project || hooks.currentSlug() !== TUTORIAL_SLUG) return;
    const events = setupEvents(step, latest.project);
    setupFor = step;
    if (!events.length) return;
    settingUp = true;
    const mine = hooks.client();
    const started = generation;
    try {
      for (const event of events) {
        if (started !== generation) return;
        await mine.apply(event);
      }
    } catch (error) {
      if (started === generation) hooks.failed(error, 'Could not prepare this step. Try again.');
    } finally { settingUp = false; }
  }

  async function goTo(next, { moved = true } = {}) {
    step = next;
    page = null;
    setupFor = null;
    stopTick();
    bench.setup(benchSetup(step));
    const started = generation;
    await view.tutorialLayout(lesson(step).panels);
    view.tutorialConsole?.(consoleSetup(step));
    if (started !== generation) return;
    await ensureSetup();
    if (started === generation) render(moved);
    await save({ tutorialStep: step });
  }

  async function start({ restart = false, resume = false } = {}) {
    if (active || busy) return false;
    busy = true;
    const started = ++generation;
    try {
      try {
        await (restart ? api.resetTutorialBoard(hooks.withToken()) : api.createTutorialBoard(hooks.withToken()));
      } catch (error) {
        hooks.failed(error, 'Could not set up the practice board. Try again.');
        return false;
      }
      if (started !== generation) return false;
      step = resume ? clampStep(hooks.settings()?.tutorialStep) : 1;
      before = { slug: hooks.currentSlug() };
      zoomed = false;
      latest = null;
      setupFor = null;
      page = null;
      facts = buildFacts({});
      bench = createBench(benchOptions);
      bench.setup(benchSetup(step));
      consoleFacts.reset();
      logicOpen = false;
      exported = false;
      startedVdev = false;
      flashAnswer = null;
      replayed = false;
      active = true;
      remember(true);
      await save({ tutorial: 'started', tutorialStep: step });
      await view.tutorialEnter(lesson(step).panels);
      view.tutorialConsole?.(consoleSetup(step));
      if (started !== generation) return false;
      hooks.openPractice();
      return true;
    } finally { busy = false; }
  }

  async function leave({ focusCreate = false } = {}) {
    if (!active) return;
    active = false;
    generation += 1;
    stopTick();
    latest = null;
    remember(false);
    await cleanup();                 // while the practice board is still the open one
    view.tutorialLeave();
    hooks.closed(before?.slug ?? null);
    before = null;
    if (focusCreate) view.tutorialFocusCreate();
  }

  /** Close the console on the practice board, so starting again is not refused, and stop the virtual board if this tutorial started it. */
  async function cleanup() {
    const closePort = consoleFacts.facts().portIsOpen;
    const stopVdev = startedVdev;
    startedVdev = false;
    if (!closePort && !stopVdev) return;
    const work = (async () => {
      if (closePort) await Promise.allSettled([hooks.closeSerial?.()]);
      if (stopVdev) await Promise.allSettled([hooks.stopVdev?.()]);
    })();
    // A service that does not answer must not keep the person in the tutorial; the calls go on in the background.
    let timer = null;
    const gaveUp = new Promise((resolve) => { timer = timers.set(resolve, CLEANUP_MS); });
    await Promise.race([work, gaveUp]);
    timers.clear(timer);
  }

  /** The board keeps every console session; what they showed is added to what this run knows, once per start. */
  async function replayRecordings(project) {
    if (replayed || !hooks.readCapture) return;
    replayed = true;
    const started = generation;
    const wanted = (project.captures ?? [])
      .filter((c) => c.kind === 'serial' && Number.isInteger(c.baud) && c.baud > 0 && typeof c.path === 'string'
        && c.path.startsWith('captures/') && !c.path.split('/').includes('..'))
      .slice(-REPLAY_RECORDINGS);
    const recordings = [];
    for (const capture of wanted) {
      try {
        const blob = await hooks.readCapture(capture.path);
        const text = await blob.slice(0, REPLAY_BYTES).text();
        recordings.push({ captureId: capture.id, baud: capture.baud, text });
      } catch { /* a recording that cannot be read is skipped */ }
      if (started !== generation) return;
    }
    consoleFacts.merge(factsFromRecordings(recordings));
    reported();
  }

  async function finish() {
    if (step < lastStep) return;
    if (step >= TOTAL_STEPS) {
      page = 'finish';
      await cleanup();
      await save({ tutorial: 'done', welcomed: true });
    } else {
      page = 'end';
    }
    render(true);
  }

  function permitAction(name) {
    if (!active) return true;
    if (allowedAction(step, name)) return true;
    view.tutorialSay(REFUSED);
    return false;
  }

  return {
    active: () => active,
    /** The sign-in was lost: stop without going anywhere. */
    abandon() {
      if (!active) return;
      active = false;
      generation += 1;
      stopTick();
      view.tutorialLeave();
    },
    start,
    leave,
    step: () => step,
    askLeave: () => { if (active) view.tutorialAskLeave(step); },
    /** The practice board's client state changed. */
    stateChanged(state) {
      if (!active) return;
      latest = state;
      if (state?.status === 'live' && state.project && hooks.currentSlug() === TUTORIAL_SLUG) replayRecordings(state.project);
      ensureSetup().then(() => render());
    },
    /** True when a reload or restart of the service in this window should go straight back into the tutorial. */
    wasRunning,
    setExtra(provider) { extra = provider; },
    async next() {
      if (!active || page === 'finish' || page === 'end') return;
      if (!stepDone(step, facts)) return;
      if (step >= lastStep) await finish(); else await goTo(step + 1);
    },
    async back() {
      if (!active) return;
      if (page === 'end') { page = null; render(true); return; }
      if (page === 'finish') { page = null; render(true); return; }
      if (step > 1) await goTo(step - 1);
    },
    finishCreate: () => leave({ focusCreate: true }),
    /** The bench. Each action asks the policy first, then redraws only the widget. */
    benchPower(on) { if (permitAction('bench-power')) { bench.setPower(on); renderBench(); } },
    benchCycle() { if (permitAction('bench-power')) { bench.powerCycle(); renderBench(); } },
    benchMode(mode) { if (permitAction('bench-mode')) { bench.setMode(mode); renderBench(); } },
    benchProbe(pin) { if (permitAction('bench-probe')) { bench.setProbe(pin); renderBench(); } },
    benchWire(line, pin) {
      if (!permitAction('wire')) return;
      bench.wire(line, pin);
      render();
    },
    /** The pin selected in the Header panel is the pin the red probe touches. */
    notePin(index) {
      if (!active || !Number.isInteger(index) || !BENCH_PINS.includes(index) || bench.state().probe === index) return;
      bench.setProbe(index);
      renderBench();
    },
    /** Write what the meter shows onto the probed pin of J4, as an ordinary reading event. */
    async benchRecord() {
      const reading = bench.reading();
      const pin = bench.state().probe;
      const schematic = facts.schematic;
      if (!active || page || !reading || !pin) return false;
      if (!schematic) { view.tutorialSay('Mark the header first.'); return false; }
      const stored = await hooks.send({ type: 'pin/readingAdded', schematicId: schematic.id, index: pin, reading });
      if (stored) view.tutorialSay(`Recorded ${reading.text} on pin ${pin}.`);
      return stored;
    },
    /** The Console view's reports: the session, the board's text, the speed chosen, what was sent and the virtual board. */
    noteConsole(event) {
      if (!active || !event) return;
      if (event.kind === 'session') consoleFacts.session(event.state ? { captureId: event.state.captureId, baud: event.state.baud } : null);
      else if (event.kind === 'data') consoleFacts.data(event.text);
      else if (event.kind === 'backlog') consoleFacts.backlog(event.text);
      else if (event.kind === 'baud') consoleFacts.chose(event.value);
      else if (event.kind === 'sent') consoleFacts.sent(event.what);
      else if (event.kind === 'vdev') consoleFacts.vdev(event.running);
      reported();
    },
    noteLogic(event) {
      if (!active || !event || logicOpen === Boolean(event.open)) return;
      logicOpen = Boolean(event.open);
      reported();
    },
    /** The choice on step 12's question: counts only once the boot text has printed. */
    answer(value) {
      const question = lesson(step).question;
      if (!active || page || !question || !facts.sawFlash || !question.choices.includes(value)) return;
      flashAnswer = value;
      if (value === question.answer) view.tutorialSay(FLASH_ANSWER_NOTE);
      render();
    },
    noteExport() {
      if (!active || exported) return;
      exported = true;
      reported();
    },
    /** The virtual board was started from the tutorial. */
    vdevStarted() { if (active) startedVdev = true; },
    noteZoom() {
      if (!active || zoomed) return;
      zoomed = true;
      render();
    },
    /** True when the event may be sent now; says why in the coach when not. */
    permit(event) {
      if (!active) return true;
      if (allowed(step, event, latest?.project)) return true;
      view.tutorialSay(REFUSED);
      return false;
    },
    permitAction,
  };
}
