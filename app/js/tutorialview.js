// The coach panel of the tutorial (UI name "Tutorial"): the step, its task list, a hint line, the reason
// for the step and a fixed footer with Back and Continue. It draws what the controller gives it and
// reports what the person pressed; the rules are in core/tutorial/. Text from the lessons is fixed, but
// every value is still set with textContent. It is not a dock panel: it is a fixed column that exists only
// while the tutorial runs.

import { CHAPTERS } from './core/tutorial/lessons.js';
import { ADAPTER_LINES, BENCH_PINS } from './core/tutorial/bench.js';
import { dom } from './dom.js';

export function createTutorialView(doc, handlers) {
  const { $, el, options } = dom(doc);
  let generation = 0;            // reset() raises it, so a late answer for the previous board is dropped
  let wasReady = false;
  let shownKey = '';
  let exampleStep = 0;           // the step whose example is drawn, so a redraw of the same step leaves the fold-out as it is
  let previous = new Set();      // tasks that were done at the last draw, so only a new tick animates
  let asking = false;
  let meter = null;              // the last meter model, so Plug in / Unplug knows which way to go
  let questionKey = '';          // the question now built, so its buttons are kept between draws
  let announced = '';            // what the polite meter line said last, so it speaks on a change only

  const panel = $('tutorial-panel');
  const reducedMotion = () => Boolean(doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

  function paragraphs(box, lines) {
    box.replaceChildren(...lines.map((line) => el('p', '', line)));
  }

  function drawChapters(current) {
    $('tutorial-chapters').replaceChildren(...CHAPTERS.map((name, index) => {
      const item = el('li', '', name);
      if (index === current) item.setAttribute('aria-current', 'step');
      item.dataset.state = index < current ? 'done' : index === current ? 'current' : 'todo';
      if (index < current) item.append(el('span', 'visually-hidden', ' (done)'));
      return item;
    }));
  }

  function drawTasks(tasks) {
    const list = $('tutorial-tasks');
    $('tutorial-task-box').hidden = tasks.length === 0;
    list.replaceChildren(...tasks.map((task) => {
      const item = el('li', task.done ? 'ok' : 'todo');
      const mark = el('span', 'mark', task.done ? '✓' : '○');
      mark.setAttribute('aria-hidden', 'true');
      item.append(mark, el('span', '', task.text));
      item.setAttribute('aria-label', `${task.done ? 'Done' : 'Not yet'}: ${task.text}`);
      if (task.done && !previous.has(task.id) && !reducedMotion()) item.classList.add('tick');
      return item;
    }));
    previous = new Set(tasks.filter((t) => t.done).map((t) => t.id));
  }

  const SVG = 'http://www.w3.org/2000/svg';
  const svg = (name, attrs = {}, text = '') => {
    const node = doc.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text) node.textContent = text;
    return node;
  };

  function drawMeter(model) {
    meter = model;
    for (const mode of ['continuity', 'dc']) $(`bench-mode-${mode}`).setAttribute('aria-pressed', String(model.mode === mode));
    for (const pin of BENCH_PINS) $(`bench-pin-${pin}`).setAttribute('aria-pressed', String(model.probe === pin));
    const screen = $('bench-reading');
    screen.textContent = model.reading.text;
    screen.dataset.kind = model.reading.kind;
    $('bench-power').textContent = model.powered ? 'Unplug the board' : 'Plug in the board';
    $('bench-power-state').textContent = model.powered ? 'The board is plugged in.' : 'The board is unplugged.';
    $('bench-record').disabled = !model.reading.recordable;
    // A jumpy reading changes four times a second; the polite line waits for it to settle.
    const line = model.reading.jumpy ? `Pin ${model.probe}: the reading is changing` : model.probe ? `Pin ${model.probe}: ${model.reading.text}` : model.reading.text;
    if (line !== announced) { announced = line; $('bench-announce').textContent = line; }
  }

  function drawWiring(model) {
    const label = (entry) => (entry.role ? `Pin ${entry.pin} (${entry.role})` : `Pin ${entry.pin}`);
    for (const line of ADAPTER_LINES) {
      const select = $(`wire-${line}`);
      const choices = [{ value: '', label: 'Open (not connected)' }, ...model.pins.map((entry) => ({ value: String(entry.pin), label: label(entry) }))];
      const key = choices.map((c) => c.label).join('|');
      if (select.dataset.key !== key) { select.dataset.key = key; options(select, choices); }
      select.value = model.wiring[line] === null ? '' : String(model.wiring[line]);
    }
    const y = (index) => 22 + index * 36;
    const figure = $('bench-figure');
    const parts = [
      svg('rect', { class: 'box', x: 8, y: 6, width: 84, height: 138, rx: 4 }),
      svg('rect', { class: 'box', x: 208, y: 6, width: 84, height: 138, rx: 4 }),
      svg('text', { x: 50, y: 18, 'text-anchor': 'middle' }, 'Adapter'),
      svg('text', { x: 250, y: 18, 'text-anchor': 'middle' }, 'J4'),
    ];
    ADAPTER_LINES.forEach((line, index) => {
      const pin = model.wiring[line];
      if (pin !== null) parts.push(svg('path', { class: `wire wire-${line}`, d: `M92 ${y(index) + 8} C150 ${y(index) + 8}, 150 ${y(pin - 1) + 8}, 208 ${y(pin - 1) + 8}` }));
    });
    ADAPTER_LINES.forEach((line, index) => {
      parts.push(svg('circle', { class: 'terminal', cx: 92, cy: y(index) + 8, r: 4 }), svg('text', { x: 16, y: y(index) + 12 }, line));
    });
    model.pins.forEach((entry, index) => {
      parts.push(svg('circle', { class: 'terminal', cx: 208, cy: y(index) + 8, r: 4 }), svg('text', { x: 216, y: y(index) + 12 }, entry.role ? `${entry.pin} ${entry.role}` : String(entry.pin)));
    });
    figure.replaceChildren(...parts);
  }

  function drawVdev(model) {
    $('tutorial-vdev-start').disabled = model.running;
    $('tutorial-vdev-state').textContent = model.running ? 'The virtual board is running. Its port is in the Console panel.' : 'The virtual board is not running.';
  }

  /** Step 12's question. The buttons stay in place between draws, so a click does not lose keyboard focus. */
  function drawQuestion(question) {
    $('tutorial-question').hidden = !question;
    if (!question) { questionKey = ''; return; }
    const key = JSON.stringify([question.legend, question.choices]);
    if (key !== questionKey) {
      questionKey = key;
      $('tutorial-question-legend').textContent = question.legend;
      $('tutorial-choices').replaceChildren(...question.choices.map((choice, n) => {
        const button = el('button', '', choice);
        button.type = 'button';
        button.id = `tutorial-choice-${n}`;
        button.addEventListener('click', () => handlers.onAnswer?.(choice));
        return button;
      }));
    }
    question.choices.forEach((choice, n) => {
      const button = $(`tutorial-choice-${n}`);
      button.disabled = !question.enabled;
      button.setAttribute('aria-pressed', String(question.chosen === choice));
    });
  }

  function drawBench(model) {
    $('bench-vdev').hidden = model?.kind !== 'vdev';
    if (model?.kind === 'vdev') drawVdev(model);
    $('bench-meter').hidden = model?.kind !== 'meter';
    $('bench-wiring').hidden = model?.kind !== 'wiring';
    if (model?.kind === 'meter') drawMeter(model);
    else if (model?.kind === 'wiring') drawWiring(model);
    else { meter = null; announced = ''; }
  }

  function drawExample(model) {
    const box = $('tutorial-example');
    box.hidden = !model.example;
    if (!model.example) return;
    if (exampleStep !== model.step) { box.open = false; exampleStep = model.step; }
    $('tutorial-example-question').textContent = model.example.question;
    $('tutorial-example-answer').textContent = model.example.answer;
  }

  function drawStep(model) {
    $('tutorial-step').hidden = false;
    $('tutorial-finish').hidden = true;
    $('tutorial-position').textContent = `Step ${model.step} of ${model.total}`;
    drawChapters(model.chapter);
    $('tutorial-step-title').textContent = model.title;
    paragraphs($('tutorial-text'), model.body);
    drawTasks(model.tasks);
    $('tutorial-hint').textContent = model.hint;
    $('tutorial-hint').hidden = !model.hint;
    drawBench(model.bench);
    drawQuestion(model.question);
    paragraphs($('tutorial-why-text'), model.why);
    drawExample(model);
    const link = $('tutorial-why-link');
    link.dataset.wiki = model.wiki;
    link.href = `#wiki/${model.wiki}`;
    $('tutorial-back').disabled = !model.canBack;
    $('tutorial-continue').disabled = !model.canContinue;
    $('tutorial-continue').textContent = model.last ? 'Finish' : 'Continue';
    $('tutorial-continue').hidden = false;
    $('tutorial-back').hidden = false;
    if (model.canContinue && !wasReady) $('tutorial-note').textContent = 'Step done.';
    else if (!model.canContinue) $('tutorial-note').textContent = '';
    wasReady = model.canContinue;
  }

  function drawFinish(model) {
    $('tutorial-step').hidden = true;
    $('tutorial-finish').hidden = false;
    $('tutorial-example').hidden = true;
    exampleStep = 0;
    $('tutorial-position').textContent = model.complete ? 'Finished' : `Step ${model.step} of ${model.total}`;
    drawChapters(model.complete ? CHAPTERS.length : model.chapter);
    $('tutorial-finish-title').textContent = model.title;
    $('tutorial-finish-lead').textContent = model.lead;
    $('tutorial-finish-list').replaceChildren(...model.lines.map((line) => {
      const item = el('li', 'ok');
      const mark = el('span', 'mark', '✓');
      mark.setAttribute('aria-hidden', 'true');
      item.append(mark, el('span', '', line));
      return item;
    }));
    $('tutorial-finish-where').textContent = model.where;
    for (const id of ['tutorial-finish-create', 'tutorial-finish-needs', 'tutorial-finish-live']) $(id).hidden = !model.complete;
    $('tutorial-back').hidden = false;
    $('tutorial-back').disabled = false;
    $('tutorial-continue').hidden = true;
    $('tutorial-note').textContent = '';
    drawBench(null);
    wasReady = false;
  }

  $('tutorial-continue').addEventListener('click', () => handlers.onContinue?.());
  $('tutorial-back').addEventListener('click', () => handlers.onBack?.());
  $('tutorial-leave-yes').addEventListener('click', () => { api.stay(false); handlers.onLeave?.(); });
  $('tutorial-leave-no').addEventListener('click', () => api.stay());
  $('tutorial-vdev-start').addEventListener('click', () => handlers.onVdevStart?.());
  $('bench-mode-continuity').addEventListener('click', () => handlers.onBenchMode?.('continuity'));
  $('bench-mode-dc').addEventListener('click', () => handlers.onBenchMode?.('dc'));
  for (const pin of BENCH_PINS) $(`bench-pin-${pin}`).addEventListener('click', () => handlers.onBenchProbe?.(pin));
  $('bench-power').addEventListener('click', () => handlers.onBenchPower?.(!meter?.powered));
  $('bench-cycle').addEventListener('click', () => handlers.onBenchCycle?.());
  $('bench-record').addEventListener('click', () => handlers.onBenchRecord?.());
  for (const line of ADAPTER_LINES) $(`wire-${line}`).addEventListener('change', (event) => handlers.onBenchWire?.(line, event.target.value === '' ? null : Number(event.target.value)));
  $('tutorial-finish-create').addEventListener('click', () => handlers.onFinishCreate?.());
  $('tutorial-finish-needs').addEventListener('click', () => handlers.onOpenWiki?.('what-you-need'));
  $('tutorial-finish-live').addEventListener('click', () => handlers.onOpenWiki?.('first-live-board'));

  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (asking) { api.stay(false); handlers.onLeave?.(); } else api.askLeave();
      return;
    }
    // Enter outside a control moves on once the step is done.
    if (event.key === 'Enter' && !event.target.closest?.('button, a, summary, input, textarea, select') && !$('tutorial-continue').disabled && !$('tutorial-continue').hidden) {
      event.preventDefault();
      handlers.onContinue?.();
    }
  });

  const api = {
    show(on) {
      panel.hidden = !on;
      if (!on) { api.stay(false); previous = new Set(); wasReady = false; shownKey = ''; }
    },
    /** Draw a step or the finish page. The title takes focus when the step changes, so a screen reader starts at the new text. */
    draw(model) {
      const key = model.kind === 'finish' ? `finish-${model.complete}` : `step-${model.step}`;
      const changed = key !== shownKey;
      if (changed) { previous = new Set(); wasReady = false; }
      if (model.kind === 'finish') drawFinish(model); else drawStep(model);
      if (changed) {
        shownKey = key;
        $('tutorial-scroll').scrollTop = 0;
        if (model.moved) $(model.kind === 'finish' ? 'tutorial-finish-title' : 'tutorial-step-title').focus();
      }
    },
    /** Redraw the meter alone, for example while pin 2 is jumpy. */
    bench(model) { drawBench(model); },
    /** A line in the polite status area, for example why a change was refused. */
    say(text) {
      $('tutorial-note').textContent = text;
    },
    /** The inline question for leaving. It names the step to resume at; Stay is the default. */
    askLeave(step = null) {
      if (!asking) {
        asking = true;
        $('tutorial-leave-text').textContent = step ? `Leave the tutorial? You can resume at step ${step} or start again from Settings.` : 'Leave the tutorial? You can start it again from Settings.';
        $('tutorial-leave-ask').hidden = false;
      }
      $('tutorial-leave-no').focus();
    },
    stay(refocus = true) {
      if (!asking) return;
      asking = false;
      $('tutorial-leave-ask').hidden = true;
      if (refocus) $('tutorial-continue').disabled ? $('tutorial-step-title').focus() : $('tutorial-continue').focus();
    },
    asking: () => asking,
    reset() { generation += 1; shownKey = ''; previous = new Set(); wasReady = false; },
    generation: () => generation,
    focusTitle() { $('tutorial-step-title').focus(); },
  };

  return api;
}
