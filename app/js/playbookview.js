// The Playbook panel: choose a playbook, follow its steps, confirm gates, answer questions, watch the
// checks turn green as the board fills in. Draws and reports intents only; the rules live in
// core/checks.js and the writes in controller.js. Playbook text is rendered with core/markdown.js,
// which never produces HTML.

import { currentStep, missingRequirements, playbookFinished, stepState } from './core/checks.js';
import { createLinkOpener } from './core/links.js';
import { renderMarkdown } from './core/markdown.js';
import { dom } from './dom.js';

export function createPlaybookView(doc, handlers) {
  const { $, el, options } = dom(doc);
  const externalLinks = () => createLinkOpener(doc.defaultView);

  let playbooks = [];
  let problems = [];
  let project = null;
  let editable = false;
  let playbookId = null;
  let stepIndex = null;          // null = follow the current step
  let guidance = 'guided';
  let confirming = false;        // Start this playbook over is asking first
  const background = new Map();  // wiki page name -> { page } or { error }, loaded once per page
  const collapsed = new Set();   // pages whose Background section was closed by hand

  const playbook = () => playbooks.find((p) => p.id === playbookId) ?? null;
  const record = () => project?.playbooks?.[playbookId] ?? {};

  $('playbook-select').addEventListener('change', (event) => {
    playbookId = event.target.value;
    stepIndex = null;
    confirming = false;
    draw();
  });

  function update(stepId, patch) {
    return handlers.onPlaybookUpdate(playbookId, stepId, patch);
  }

  function drawHeader() {
    options($('playbook-select'), playbooks.map((p) => ({
      value: p.id,
      label: `${playbookFinished(p, project?.playbooks?.[p.id]) ? '✓ ' : ''}${p.title}`,
      selected: p.id === playbookId,
    })));
    $('playbook-problems').hidden = problems.length === 0;
    $('playbook-problems').replaceChildren(...problems.map((pr) => el('li', '', `${pr.file.split('/').pop()}: ${pr.message}`)));
  }

  function drawSteps(pb) {
    const states = pb.steps.map((_, i) => stepState(pb, i, project, guidance));
    $('playbook-summary').textContent = pb.summary || '';
    const missing = missingRequirements(pb, playbooks, project);
    $('playbook-requires').hidden = missing.length === 0;
    $('playbook-requires').textContent = missing.length
      ? `This playbook builds on ${missing.map((id) => playbooks.find((p) => p.id === id)?.title ?? id).join(', ')}. Finish ${missing.length > 1 ? 'them' : 'it'} on this board first.`
      : '';

    $('step-list').replaceChildren(...states.map((state, i) => {
      const item = el('li');
      const button = el('button', 'step');
      button.type = 'button';
      button.dataset.state = state.done ? 'done' : state.open ? 'open' : 'locked';
      button.setAttribute('aria-current', String(i === stepIndex));
      button.disabled = !state.open;
      const mark = el('span', 'mark', state.done ? '✓' : state.open ? String(i + 1) : '🔒');
      mark.setAttribute('aria-hidden', 'true');
      button.append(mark, el('span', 'title', state.step.title));
      button.setAttribute('aria-label', `Step ${i + 1}: ${state.step.title}${state.done ? ', done' : state.open ? '' : ', locked'}`);
      button.addEventListener('click', () => { stepIndex = i; draw(); });
      item.append(button);
      return item;
    }));
    return states;
  }

  /** Guided mode: the step's first wiki page, open under the step. Closing it is remembered per page. */
  function backgroundSection(name) {
    const box = el('details', 'background');
    box.open = !collapsed.has(name);
    box.addEventListener('toggle', () => { if (box.open) collapsed.delete(name); else collapsed.add(name); });
    const entry = background.get(name);
    const summary = el('summary', '', `Background: ${entry?.page?.title ?? name.replace(/-/g, ' ')}`);
    const body = el('div', 'md');
    if (!entry) {
      body.append(el('p', 'hint', 'The app loads the page.'));
      background.set(name, { loading: true });
      Promise.resolve(handlers.loadWikiPage?.(name))
        .then((page) => { background.set(name, page ? { page } : { error: 'There is no such page.' }); })
        .catch((error) => { background.set(name, { error: error.status === 404 ? `There is no page called ${name} yet.` : error.message }); })
        .finally(() => draw());
    } else if (entry.loading) {
      body.append(el('p', 'hint', 'The app loads the page.'));
    } else if (entry.error) {
      body.append(el('p', 'hint', entry.error));
    } else {
      // The page's own # title repeats the summary, so leave it out.
      body.append(renderMarkdown(doc, entry.page.markdown.replace(/^# .*\n/, ''), {
        onWikiLink: (n) => handlers.onOpenWiki?.(n), loadFigure: handlers.loadWikiFigure,
        openExternal: externalLinks() }));
    }
    box.append(summary, body);
    return box;
  }

  function section(title, child) {
    const box = el('section', 'step-part');
    box.append(el('h4', '', title), child);
    return box;
  }

  function drawDetail(pb, state) {
    const { step } = state;
    const detail = $('step-detail');
    // Keep what is being typed in a question box across redraws.
    const active = doc.activeElement?.dataset?.ask ? { id: doc.activeElement.dataset.ask, value: doc.activeElement.value } : null;

    const parts = [el('h3', '', `${stepIndex + 1}. ${step.title}`)];
    const why = el('div', 'md');
    why.append(renderMarkdown(doc, step.why, { openExternal: externalLinks() }));
    const todo = el('div', 'md');
    todo.append(renderMarkdown(doc, step.do, { openExternal: externalLinks() }));
    if (guidance === 'expert') {
      const more = el('details', 'step-more');
      more.append(el('summary', '', 'Details'), section('Why', why), section('What to do', todo));
      parts.push(more);
    } else {
      parts.push(section('Why', why), section('What to do', todo));
    }

    // Expert keeps only the confirmations that guard against damage.
    const shownGates = state.gates.filter(({ gate }) => guidance !== 'expert' || gate.destructive);
    if (shownGates.length) {
      const gates = el('ul', 'gates');
      for (const { gate, ticked } of shownGates) {
        const label = el('label', gate.destructive ? 'gate destructive' : 'gate');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = ticked;
        box.disabled = !editable || state.done || !state.open;
        box.addEventListener('change', () => {
          update(step.id, { gates: { ...(record().steps?.[step.id]?.gates ?? {}), [gate.id]: box.checked } });
        });
        label.append(box, el('span', '', gate.text));
        const li = el('li');
        li.append(label);
        gates.append(li);
      }
      parts.push(section('Before you start', gates));
    }

    if (state.asks.length) {
      const asks = el('div', 'asks');
      for (const { ask, value } of state.asks) {
        const label = el('label', '', ask.label + (ask.required || guidance === 'expert' ? '' : ' (optional)'));
        const input = el('input');
        input.type = 'text';
        input.maxLength = 200;
        input.dataset.ask = ask.id;
        input.placeholder = ask.placeholder ?? '';
        input.value = active?.id === ask.id ? active.value : value;
        input.disabled = !editable || !state.open;
        input.addEventListener('change', () => {
          update(step.id, { answers: { ...(record().steps?.[step.id]?.answers ?? {}), [ask.id]: input.value.trim() } });
        });
        label.append(input);
        asks.append(label);
      }
      parts.push(section('Write down', asks));
    }

    if (state.checks.length) {
      const checks = el('ul', 'checks');
      for (const { check, ok, detail: what } of state.checks) {
        const li = el('li', ok ? 'ok' : 'todo');
        const mark = el('span', 'mark', ok ? '✓' : '○');
        mark.setAttribute('aria-hidden', 'true');
        li.append(mark, el('span', '', check.text));
        if (what) li.append(el('span', 'detail', what));
        li.setAttribute('aria-label', `${ok ? 'Passes' : 'Not yet'}: ${check.text}`);
        checks.append(li);
      }
      parts.push(section('Checks', checks));
    }

    if (step.done_when) parts.push(el('p', 'done-when', `Done when: ${step.done_when}`));
    if (guidance === 'guided' && step.wiki?.[0]) parts.push(backgroundSection(step.wiki[0]));
    if (step.wiki?.length) {
      const more = el('p', 'wiki-links', 'Read more: ');
      for (const name of step.wiki) {
        const link = el('a', 'wiki-link', name.replace(/-/g, ' '));
        link.href = `#wiki/${name}`;
        link.addEventListener('click', (event) => { event.preventDefault(); handlers.onOpenWiki?.(name); });
        more.append(link);
      }
      parts.push(more);
    }

    const notes = [...state.blockers.map((b) => ['blocker', b]), ...state.warnings.map((w) => ['warning', w])];
    if (notes.length && !state.done) {
      const list = el('ul', 'step-notes');
      for (const [kind, text] of notes) list.append(el('li', kind, text));
      parts.push(list);
    }

    const actions = el('div', 'step-actions');
    if (state.done) {
      const reopen = el('button', '', 'Reopen step');
      reopen.type = 'button';
      reopen.disabled = !editable;
      reopen.addEventListener('click', () => update(step.id, { done: null }));
      actions.append(el('span', 'done-badge', 'Done'), reopen);
    } else {
      const complete = el('button', 'primary', 'Mark step done');
      complete.type = 'button';
      complete.id = 'step-complete';
      complete.disabled = !editable || !state.canComplete;
      complete.addEventListener('click', async () => {
        const ok = await update(step.id, { done: new Date().toISOString() });
        if (ok && stepIndex < pb.steps.length - 1) { stepIndex += 1; draw(); }
      });
      actions.append(complete);
    }
    if (stepIndex < pb.steps.length - 1) {
      const next = el('button', '', 'Next step');
      next.type = 'button';
      next.disabled = !stepState(pb, stepIndex + 1, project, guidance).open;
      next.addEventListener('click', () => { stepIndex += 1; draw(); });
      actions.append(next);
    }
    if (handlers.onAsk) {
      const ask = el('button', 'ask-assistant');
      ask.append(el('span', 'guide', 'Ask the assistant about this step'), el('span', 'terse', 'Ask'));
      ask.type = 'button';
      ask.dataset.ai = '';
      ask.addEventListener('click', () => handlers.onAsk(`Explain this step and what to check: ${step.title}`, { playbook: pb.id, step: step.id }));
      actions.append(ask);
    }
    parts.push(actions);
    detail.replaceChildren(...parts);

    if (active) {
      const again = [...detail.querySelectorAll('[data-ask]')].find((i) => i.dataset.ask === active.id);
      again?.focus();
    }
  }

  /** Steps with a done mark or a ticked box; what was written under Write down does not count. */
  function stepsWithProgress() {
    return Object.entries(record().steps ?? {})
      .filter(([, step]) => step.done || Object.values(step.gates ?? {}).some(Boolean))
      .map(([id]) => id);
  }

  /** Start this playbook over: asks inline first, then clears done marks and ticks one step at a time. */
  function drawRestart() {
    const box = $('playbook-restart');
    const focused = box.contains(doc.activeElement) ? doc.activeElement.id : '';   // kept across a redraw from a board update
    const steps = stepsWithProgress();
    box.hidden = steps.length === 0;
    if (!steps.length) { confirming = false; box.replaceChildren(); return; }
    const ask = el('button', '', 'Start this playbook over');
    ask.type = 'button';
    ask.id = 'playbook-restart-ask';
    ask.disabled = !editable;
    if (!confirming) {
      ask.addEventListener('click', () => { confirming = true; drawRestart(); $('playbook-restart-confirm').focus(); });
      box.replaceChildren(ask);
      if (focused) $(focused)?.focus();
      return;
    }
    const cancel = () => { confirming = false; drawRestart(); $('playbook-restart-ask').focus(); };
    const yes = el('button', 'primary', 'Start over');
    yes.type = 'button';
    yes.id = 'playbook-restart-confirm';
    yes.disabled = !editable;
    yes.addEventListener('click', async () => {
      yes.disabled = true;
      confirming = false;
      const id = playbookId;      // the choice may change while the events are sent
      for (const step of steps) if (!(await handlers.onPlaybookUpdate(id, step, { done: null, gates: {} }))) break;
      if (playbookId !== id) return;
      stepIndex = 0;
      draw();
      $('step-list').querySelector('button')?.focus();
    });
    const no = el('button', '', 'Cancel');
    no.type = 'button';
    no.id = 'playbook-restart-cancel';
    no.addEventListener('click', cancel);
    const row = el('div', 'restart-confirm');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Start this playbook over');
    row.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } });
    const actions = el('div', 'step-actions');
    actions.append(yes, no);
    row.append(el('p', '', 'Clear every tick and done mark in this playbook? The app keeps what you wrote under Write down.'), actions);
    box.replaceChildren(row);
    if (focused) $(focused)?.focus();
  }

  function draw() {
    if (!project) return;
    $('playbook-empty').hidden = playbooks.length > 0;
    $('playbook-body').hidden = playbooks.length === 0;
    drawHeader();
    if (!playbooks.length) return;
    if (!playbook()) {
      playbookId = (playbooks.find((p) => !playbookFinished(p, project.playbooks?.[p.id])) ?? playbooks[0]).id;
      stepIndex = null;
      drawHeader();
    }
    const pb = playbook();
    if (!pb.steps.length) {
      $('playbook-summary').textContent = pb.summary || '';
      $('playbook-requires').hidden = true;
      $('step-list').replaceChildren();
      $('step-detail').replaceChildren(el('p', 'hint', 'This playbook has no steps.'));
      $('playbook-restart').hidden = true;
      return;
    }
    if (stepIndex === null || stepIndex >= pb.steps.length) stepIndex = currentStep(pb, project);
    const states = drawSteps(pb);
    drawDetail(pb, states[stepIndex]);
    drawRestart();
  }

  return {
    setPlaybooks(list, found) {
      playbooks = Array.isArray(list) ? list : [];
      problems = Array.isArray(found) ? found : [];
      draw();
    },
    render(nextProject, isEditable) {
      project = nextProject;
      editable = isEditable;
      draw();
    },
    setGuidance(level) {
      guidance = level === 'expert' ? 'expert' : 'guided';
      draw();
    },
    reset() {
      playbookId = null;
      stepIndex = null;
      confirming = false;
    },
    /** Open a playbook at a step, for example from the timeline. */
    focus(id, stepId) {
      const pb = playbooks.find((p) => p.id === id);
      if (!pb) return;
      playbookId = id;
      const index = pb.steps.findIndex((s) => s.id === stepId);
      stepIndex = index >= 0 ? index : null;
      draw();
    },
  };
}
