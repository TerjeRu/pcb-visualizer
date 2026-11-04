// The DOM side of the app. It only draws and reports what the person did; the decisions are in
// controller.js. Text from boards is untrusted (names, notes, device output), so everything is written
// with textContent and value, never as HTML. A test enforces that.

import { createBoardView } from './boardview.js';
import { createPlaybookView } from './playbookview.js';
import { createWikiView } from './wikiview.js';
import { createConsoleView } from './consoleview.js';
import { createTimelineView } from './timelineview.js';
import { createDock, showSinglePanel } from './dock.js';
import { createTerminalView } from './terminalview.js';
import { createLogicView } from './logicview.js';
import { createAssistantView } from './assistantview.js';
import { createSettingsView } from './settingsview.js';
import { createWelcomeView } from './welcomeview.js';
import { createTutorialView } from './tutorialview.js';
import { createExportView } from './exportview.js';
import { createPanelBus } from './panelbus.js';
import { PANELS, tutorialLayout } from './core/layout.js';
import { clock, describeEvent, statusLabel, summarize } from './viewmodel.js';
import { dom } from './dom.js';
import { guessName } from './core/format.js';

const MESSAGE_MS = 6000;
const THEMES = ['system', 'light', 'dark'];
const ASK_LIMIT = 8000;
const HELD_LIMIT = 4;
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// What a window accepts from another window, checked again here because the sender is not trusted.
const PAYLOADS = {
  ask: (p) => typeof p.text === 'string' && p.text.length <= ASK_LIMIT && (p.context === undefined || isRecord(p.context)),
  wiki: (p) => typeof p.name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(p.name),
  jump: (p) => isRecord(p.target) && typeof p.target.kind === 'string',
};
const NOTICE_TEXT = {
  timeout: (panel) => `The ${PANELS[panel]} panel did not respond.`,
  'too-large': () => 'That request is too large to send to another window.',
  unavailable: () => 'This browser cannot pass requests between windows.',
  invalid: () => 'That request cannot be sent to another window.',
};
const ASK_PLACEHOLDER = {
  guided: 'Ask about this board, a capture or a step. It can read the board and suggest a command, but you decide what runs.',
  expert: 'Ask about this board',
};

export function createView(doc, handlers, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) }, options = {}) {
  const { $, options: fillSelect } = dom(doc);
  let messageTimer = null;
  let lastState = null;
  let layoutStarted = false;
  const single = options.single ?? null;      // a window that shows one panel only
  const shown = (panel) => (single ? single === panel : dock.isVisible(panel));
  let bus = null;                             // panel channel; null where the browser has none
  let failedDelivery = null;                  // the request the notice offers to retry
  let layoutReady = Promise.resolve();        // the saved workspace is in place
  let tutorialLock = null;                    // while the tutorial runs: the Guided/Expert level to put back

  // Panels come into view through the dock: from links, the timeline, or a click on their tab.
  function showPanel(name) {
    if (single) return;
    dock.show(name);
    afterShow();
  }

  /** Actions arrive from this window's views or from another window; both end here. */
  const run = {
    ask: (p) => assistantView.ask(p.text, p.context),
    wiki: (p) => wiki.open(p.name),
    jump: ({ target }) => {
      if (target.kind === 'playbook') playbook.focus(target.playbookId, target.stepId);
      else if (target.kind === 'logic') logicView.focus(target.id);
      else board.focus(target);
    },
  };
  const assistantOn = () => doc.documentElement.dataset.assistant === 'on';
  // Until the setting has arrived the markup says "off", which would refuse an Ask that was only early.
  // The panel bus has already acknowledged it, so it waits here and is run or refused when the setting is known.
  let assistantKnown = false;
  const heldAsks = [];
  const perform = (panel, action, payload) => {
    if (!PAYLOADS[action]?.(payload)) return;
    if (panel === 'assistant' && !assistantKnown) { if (heldAsks.length < HELD_LIMIT) heldAsks.push([action, payload]); return; }
    if (panel === 'assistant' && !assistantOn()) { showError('The assistant is off. Turn it on in Settings to ask it.'); return; }
    showPanel(panel);
    run[action](payload);
  };

  function showNotice(panel, action, payload, reason) {
    failedDelivery = { panel, action, payload };
    $('delivery-text').textContent = NOTICE_TEXT[reason]?.(panel) ?? NOTICE_TEXT.invalid();
    $('delivery-back').hidden = Boolean(single);
    $('delivery-notice').hidden = false;
  }
  const hideNotice = () => { failedDelivery = null; $('delivery-notice').hidden = true; };

  async function sendRemote(panel, action, payload) {
    const result = bus ? await bus.send(panel, action, payload) : { ok: false, reason: 'unavailable' };
    if (result.ok) hideNotice(); else showNotice(panel, action, payload, result.reason);
  }

  /**
   * Run an action where its panel is. A panel docked here is shown and used directly; one in another
   * window gets the action over the channel (and its window comes to the front); one whose window is gone
   * comes back to its place first. A panel that does not answer is reported, never asked twice by itself.
   */
  function deliver(panel, action, payload) {
    const here = single ? single === panel : dock.route(panel) === 'here';
    if (here) perform(panel, action, payload); else sendRemote(panel, action, payload);
  }

  $('delivery-retry').addEventListener('click', () => {
    const request = failedDelivery;
    hideNotice();
    if (request) deliver(request.panel, request.action, request.payload);
  });
  $('delivery-back').addEventListener('click', () => {
    const request = failedDelivery;
    hideNotice();
    if (request) dock?.bringBack(request.panel);
  });
  $('delivery-dismiss').addEventListener('click', hideNotice);
  // Panels that load data or poll only do so while they are on screen.
  function afterShow() {
    if (shown('timeline')) timeline.show(lastState); else timeline.hide();
    if (shown('wiki')) wiki.ensure();
    if (shown('terminal')) terminalView.shown();
    if (shown('logic')) logicView.shown();
    if (shown('assistant')) assistantView.ensure();
  }
  const wiki = createWikiView(doc, handlers);
  const exportView = createExportView(doc, handlers);
  // A panel in its own window has no Wiki beside it, so a wiki link swaps that panel for the Wiki in
  // the same window. The window title stays, because KWin rules place panel windows by title.
  const swapsInWindow = single && single !== 'wiki';
  function showWikiInWindow(show) {
    const own = $(`panel-${single}`);
    if (show) own.after($('panel-wiki'));
    own.hidden = show;
    $('panel-wiki').hidden = !show;
  }
  // The Back button returns to the tab the Wiki was opened over, and names it.
  let wikiOrigin = null;
  let wikiOriginAway = null;      // the target of the layout the tutorial lent its own over, for when that layout comes back
  function setWikiOrigin(panel) {
    wikiOrigin = panel;
    $('wiki-back').hidden = !panel;
    if (panel) $('wiki-back').textContent = `← Back to ${PANELS[panel] ?? panel}`;
  }
  const openWiki = (name) => {
    if (!single) {
      if (!welcomeOpener) {
        const beside = dock?.activeBeside('wiki') ?? null;
        if (beside) setWikiOrigin(beside);
        else if (!dock?.isDocked('wiki') || !dock.isVisible('wiki')) setWikiOrigin(null);
      }
      deliver('wiki', 'wiki', { name });
      return;
    }
    if (swapsInWindow) showWikiInWindow(true);
    wiki.open(name);
  };
  // Explainer links in the markup name their page in data-wiki. Rendered Markdown links handle their
  // own click and cancel it, so they are skipped here.
  doc.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[data-wiki]');
    if (!link || event.defaultPrevented) return;
    event.preventDefault();
    openWiki(link.dataset.wiki);
  });
  // Timeline entries jump to what they are about.
  const jump = (target) => deliver(target.kind === 'playbook' ? 'playbook' : target.kind === 'logic' ? 'logic' : 'photo', 'jump', { target });
  const timeline = createTimelineView(doc, { ...handlers, onJump: jump });
  // The Welcome opens wiki pages before any board exists; Back then returns to the button that opened one.
  let welcomeOpener = null;
  function leaveWelcomeWiki() {
    if (!welcomeOpener) return;
    welcomeOpener = null;
    setWikiOrigin(null);
  }
  $('wiki-back').addEventListener('click', () => {
    if (welcomeOpener) {
      const opener = welcomeOpener;
      leaveWelcomeWiki();
      show('empty-panel');
      $(opener).focus();
    } else if (swapsInWindow) showWikiInWindow(false);
    else if (wikiOrigin) showPanel(wikiOrigin);
  });
  if (single) {
    $('wiki-back').textContent = `← Back to ${PANELS[single] ?? single}`;
    $('wiki-back').hidden = single === 'wiki';
  }
  const consoleView = createConsoleView(doc, { ...handlers, onAsk: (text, context) => askAssistant(text, context) });
  const terminalView = createTerminalView(doc, handlers);
  const logicView = createLogicView(doc, { ...handlers, onAsk: (text, context) => askAssistant(text, context) }, timers);
  const assistantView = createAssistantView(doc, { ...handlers, onOpenWiki: (name) => openWiki(name) });
  const settingsView = createSettingsView(doc, { ...handlers, onOpen: () => { if (assistantOn()) assistantView.ensure(); } });
  // The wiki lives in the board panel, so the Welcome brings that panel up even before the first board.
  const welcome = createWelcomeView(doc, {
    ...handlers,
    showError: (message) => showError(message),
    onOpenSettings: (section) => settingsView.open(section),
    onReadPage: (name, opener) => {
      welcomeOpener = opener;
      $('wiki-back').textContent = '← Back to the welcome';
      $('wiki-back').hidden = false;
      show('board-panel');
      openWiki(name);
    },
  });
  const tutorialView = createTutorialView(doc, {
    onContinue: () => handlers.tutorialNext?.(),
    onBack: () => handlers.tutorialBack?.(),
    onLeave: () => handlers.leaveTutorial?.(),
    onFinishCreate: () => handlers.tutorialFinishCreate?.(),
    onBenchMode: (mode) => handlers.benchMode?.(mode),
    onBenchProbe: (pin) => handlers.benchProbe?.(pin),
    onBenchPower: (on) => handlers.benchPower?.(on),
    onBenchCycle: () => handlers.benchCycle?.(),
    onBenchRecord: () => handlers.benchRecord?.(),
    onBenchWire: (line, pin) => handlers.benchWire?.(line, pin),
    onAnswer: (value) => handlers.tutorialAnswer?.(value),
    onVdevStart: () => consoleView.startVirtualBoard(),
    onOpenWiki: (name) => openWiki(name),
  });
  $('tutorial-leave').addEventListener('click', () => handlers.askLeaveTutorial?.());
  // Everything in the top bar except the way out is inert while the tutorial runs: it cannot be clicked,
  // focused or reached by a screen reader, so there is no half-locked state.
  function lockBar(on) {
    for (const node of doc.querySelector('header.bar').children) {
      if (node.tagName === 'H1' || ['tutorial-leave', 'status', 'storage-warning'].includes(node.id)) continue;
      if (on) node.setAttribute('inert', ''); else node.removeAttribute('inert');
    }
    $('guidance-guided').parentElement.title = on ? 'Locked while the tutorial runs' : '';
  }
  // The highlight: the control the step needs carries `tutorial-target`. The coach hands over an id with
  // every draw; the dock redraws its tabs on every layout change, so the class is put back after each one.
  let targetId = null;
  let targetKey = '';     // what was last scrolled to, so a redraw of the same control does not scroll again
  /** The node to ring for an id: the control, or its panel's tab when that panel is not the one showing. */
  function targetNode(id) {
    const wanted = id ? $(id) : null;
    if (!wanted || wanted.disabled || wanted.closest('[inert]')) return null;
    if (!wanted.closest('[hidden]')) return wanted;
    const panel = wanted.closest('[data-panel]');
    const tab = panel?.hidden && wanted.closest('[hidden]') === panel ? $(`region-tab-${panel.dataset.panel}`) : null;
    return tab && !tab.closest('[hidden], [inert]') ? tab : null;
  }
  function applyTarget(id = targetId) {
    targetId = id;
    for (const node of doc.querySelectorAll('.tutorial-target')) node.classList.remove('tutorial-target');
    const node = targetNode(id);
    const key = node ? node.id : '';
    if (node) {
      node.classList.add('tutorial-target');
      if (key !== targetKey) node.scrollIntoView?.({ block: 'nearest' });
    }
    targetKey = key;
  }
  // A target can turn usable after the coach drew, such as Connect once the virtual board's port is listed.
  const Watch = doc.defaultView?.MutationObserver;
  const targetWatch = Watch ? new Watch(() => applyTarget()) : null;
  const WATCHED = { subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'inert'] };
  // In the tutorial no question goes to a model; the coach shows example answers instead.
  const askAssistant = (text, context) => {
    if (doc.documentElement.dataset.tutorial === 'on') {
      tutorialView.say('In the tutorial, the assistant\'s answers are examples. Open "Ask the assistant (example)" below the step.');
      return;
    }
    deliver('assistant', 'ask', context ? { text, context } : { text });
  };
  function resetBoardViews() {
    board.reset();
    playbook.reset();
    consoleView.reset();
    timeline.reset();
    terminalView.reset();
    logicView.reset();
    assistantView.reset();
    exportView.reset();
  }
  const viewHandlers = { ...handlers, onOpenWiki: openWiki };
  const dock = single ? null : createDock(doc, {
    ...handlers,
    openPanelWindow: (panel) => handlers.openPanelWindow?.(panel, bus?.generation() ?? 0),
    findPanelWindow: (panel) => handlers.findShellWindow?.(panel) ?? bus?.findPeer(panel) ?? null,
    onStatus: (text) => showError(text),
    onPanelHome: (panel) => bus?.panelHome(panel),
    // Windows that said hello before the saved workspace was in place, for a panel it shows here.
    onSettled: () => { for (const panel of Object.keys(PANELS)) if (dock.holds(panel)) bus?.sendHome(panel); },
    onShow: (panel) => { if (panel === 'console') consoleView.refreshPorts(); afterShow(); },
    onLayout: () => { afterShow(); applyTarget(); },
  });

  const board = createBoardView(doc, { ...viewHandlers, onAsk: (text, context) => askAssistant(text, context) });
  const playbook = createPlaybookView(doc, { ...viewHandlers, onAsk: (text, context) => askAssistant(text, context) });

  const panels = ['token-panel', 'empty-panel', 'board-panel'];
  const show = (id) => panels.forEach((panel) => { $(panel).hidden = panel !== id; });

  function showError(message) {
    const box = $('message');
    box.textContent = message;
    box.hidden = false;
    if (messageTimer !== null) timers.clear(messageTimer);
    messageTimer = timers.set(() => { box.hidden = true; messageTimer = null; }, MESSAGE_MS);
  }

  function setStatus(status, detail) {
    const chip = $('status');
    chip.dataset.state = status;
    chip.textContent = statusLabel(status);
    chip.title = detail || '';
  }

  const fields = { name: $('field-name'), device: $('field-device'), notes: $('field-notes') };
  const readFields = () => ({ name: fields.name.value, device: fields.device.value, notes: fields.notes.value });
  const save = () => handlers.onSaveDetails(readFields());
  // Enter saves a single-line field. Notes saves on leaving the field, so Enter stays a newline there.
  fields.name.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); fields.name.blur(); } });
  fields.device.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); fields.device.blur(); } });
  for (const input of Object.values(fields)) input.addEventListener('change', save);
  // A field skips updates while focused. On leaving it unchanged, catch up so the next edit starts from current text.
  let latest = null;
  const drawn = {};
  for (const [key, input] of Object.entries(fields)) {
    input.addEventListener('blur', () => {
      if (latest && input.value === drawn[key]) input.value = drawn[key] = latest[key] ?? '';
    });
  }
  $('details-form').addEventListener('submit', (event) => event.preventDefault());

  $('guidance-guided').addEventListener('click', () => handlers.onSetGuidance?.('guided'));
  $('guidance-expert').addEventListener('click', () => handlers.onSetGuidance?.('expert'));
  $('theme-select').addEventListener('change', (event) => handlers.onSetTheme?.(event.target.value));
  $('board-select').addEventListener('change', (event) => { if (event.target.value) handlers.onSelectBoard(event.target.value); });
  $('new-board-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('new-board-name');
    handlers.onCreateBoard(input.value);
    input.value = '';
  });
  $('token-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('token-input');
    const value = input.value;
    input.value = '';
    handlers.onSubmitToken(value);
  });

  if (options.channel) {
    bus = createPanelBus({
      channel: options.channel, win: doc.defaultView, panel: single, slug: options.slug ?? null, generation: options.generation ?? Date.now(),
      isLocal: (panel) => (single ? single === panel : dock.holds(panel)),
      onAction: (panel, action, payload) => { handlers.focusWindow?.(); perform(panel, action, payload); },
      onBoard: (slug) => handlers.onSelectBoard(slug),
      // A window that says hello for a panel this window already shows would run its actions a second time.
      onHello: (panel) => { if (dock?.settled() && dock.holds(panel)) bus.sendHome(panel); },
      // The main window shows this panel again. A pop-up closes; a window the browser keeps open says so.
      onRetired: () => {
        showError(`${PANELS[single]} is back in the main window. You can close this window.`);
        try { doc.defaultView?.close?.(); } catch { /* not a window this page may close */ }
      },
      timers,
    });
  }

  return {
    showTokenPanel(message) {
      show('token-panel');
      $('token-text').textContent = message;
      $('board-select').disabled = true;
      $('new-board-button').disabled = true;
      setStatus('idle');
    },

    /** The saved `welcomed` setting and the data folder: the Welcome replaces "No boards yet" until it ends. */
    setWelcome(info) { welcome.set(info); },

    showNoBoards() {
      leaveWelcomeWiki();
      show('empty-panel');
      setStatus('idle');
    },

    /** Settings, Show the welcome: the Welcome in place of the board, whatever the saved setting says. */
    showWelcome({ back }) {
      welcome.open({ back });
      this.showNoBoards();
    },

    /** Apply the saved workspace (main window) or show the one panel (panel window). Once, after sign-in. */
    startLayout() {
      if (layoutStarted) return;
      layoutStarted = true;
      if (single) { showSinglePanel(doc, single); afterShow(); if (single === 'console') consoleView.refreshPorts(); }
      else layoutReady = dock.start();
    },

    showBoardPanel() {
      leaveWelcomeWiki();
      welcome.close();
      show('board-panel');
      resetBoardViews();
    },

    /** Guided or Expert for the whole app: CSS hides the help, the panels change what they draw. */
    setGuidance(level) {
      const value = level === 'expert' ? 'expert' : 'guided';
      if (tutorialLock) { tutorialLock.guidance = value; return; }
      if (doc.documentElement.dataset.guidance === value) return;
      doc.documentElement.dataset.guidance = value;
      $('guidance-guided').setAttribute('aria-pressed', String(value === 'guided'));
      $('guidance-expert').setAttribute('aria-pressed', String(value === 'expert'));
      settingsView.setGuidance(value);
      $('assistant-input').placeholder = ASK_PLACEHOLDER[value];
      playbook.setGuidance(value);
      if (lastState) this.render(lastState);
    },

    /**
     * The assistant setting for this window. Off hides everything marked data-ai, takes the Agent panel
     * out of the layout (closing its window), and redraws what shows AI wording. A window that holds
     * only the Agent panel has nothing left to show and closes.
     */
    setAssistant(setting) {
      const value = setting === 'on' ? 'on' : 'off';
      const first = !assistantKnown;
      assistantKnown = true;
      if (doc.documentElement.dataset.assistant !== value) {
        doc.documentElement.dataset.assistant = value;
        settingsView.setAssistant(value);
        if (value === 'on' && settingsView.isOpen()) assistantView.ensure();
        dock?.setAssistant(value);
        if (value === 'off' && single === 'assistant') {
          showError('The assistant was turned off, so this window has nothing to show. You can close it.');
          try { doc.defaultView?.close?.(); } catch { /* not a window this page may close */ }
        }
        if (lastState) this.render(lastState);
      }
      if (first) for (const [action, payload] of heldAsks.splice(0)) perform('assistant', action, payload);
    },

    /** The git setting for this window. Off leaves commits out of the timeline and hides what is only about them. */
    setGit(setting) {
      const value = setting === 'on' ? 'on' : 'off';
      if (doc.documentElement.dataset.git === value) return;
      doc.documentElement.dataset.git = value;
      settingsView.setGit(value);
      timeline.setGit();
    },

    /** data-theme holds the resolved theme; System resolves to the desktop's preference now, and theme.js follows later changes. */
    setTheme(theme) {
      const value = THEMES.includes(theme) ? theme : 'system';
      const root = doc.documentElement;
      const dark = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
      root.dataset.themeSetting = value;
      root.dataset.theme = value === 'system' ? (dark ? 'dark' : 'light') : value;
      $('theme-select').value = value;
      try { doc.defaultView?.localStorage?.setItem('pcbv-theme', value); } catch { /* storage blocked */ }
    },

    /** The saved tutorial state, for the Welcome and the Settings section. */
    setTutorial(info) {
      welcome.setTutorial(info);
      settingsView.setTutorial(info);
    },

    /** The tutorial starts: Guided is forced, the top bar locks, the coach opens and the panels become the step's. */
    async tutorialEnter(panels) {
      const root = doc.documentElement;
      const previous = root.dataset.guidance === 'expert' ? 'expert' : 'guided';
      this.setGuidance('guided');
      tutorialLock = { guidance: previous };
      root.dataset.tutorial = 'on';
      targetWatch?.observe(root, WATCHED);
      lockBar(true);
      $('tutorial-leave').hidden = false;
      tutorialView.reset();
      tutorialView.show(true);
      consoleView.tutorial({});
      wikiOriginAway = wikiOrigin;
      setWikiOrigin(null);
      await layoutReady;
      dock?.lock(true);
      dock?.lend(tutorialLayout(panels));
    },

    /** The panels the next step needs. */
    async tutorialLayout(panels) {
      await layoutReady;
      dock?.lend(tutorialLayout(panels));
    },

    /** The tutorial ends: the top bar, the panels and the Guided/Expert level come back as they were. */
    tutorialLeave() {
      const root = doc.documentElement;
      delete root.dataset.tutorial;
      lockBar(false);
      $('tutorial-leave').hidden = true;
      tutorialView.show(false);
      targetWatch?.disconnect();
      applyTarget(null);
      consoleView.tutorial(null);
      dock?.lock(false);
      dock?.restore();
      setWikiOrigin(wikiOriginAway);
      wikiOriginAway = null;
      const level = tutorialLock?.guidance ?? 'guided';
      tutorialLock = null;
      this.setGuidance(level);
    },

    tutorialConsole: (setup) => consoleView.tutorial(setup),
    tutorialDraw: (model) => { tutorialView.draw(model); applyTarget(model.target ?? null); },
    tutorialBench: (model) => tutorialView.bench(model),
    tutorialSay: (text) => tutorialView.say(text),
    tutorialAskLeave: (step) => tutorialView.askLeave(step),
    tutorialFocusCreate: () => $('new-board-name').focus(),

    serialMessage(message) {
      consoleView.message(message);
      if (message.op === 'serial') assistantView.serialChanged();
    },

    setPlaybooks(list, problems) {
      playbook.setPlaybooks(list, problems);
      timeline.setPlaybooks(list);
    },

    /** `selected` null with boards in the list (the Welcome over a closed board) shows "Choose a board", so picking any board is a change. */
    setBoards(slugs, selected) {
      const select = $('board-select');
      const none = selected === null && slugs.length ? [{ value: '', label: 'Choose a board', selected: true }] : [];
      fillSelect(select, [...none, ...slugs.map((slug) => ({ value: slug, label: slug, selected: slug === selected }))]);
      select.disabled = slugs.length === 0;
      $('new-board-button').disabled = false;
    },

    showError,

    /** The board on screen changed. The main window announces it so panel windows follow; a panel window only records it. */
    boardChanged(slug) {
      if (!bus) return;
      if (single) bus.followBoard(slug); else bus.announceBoard(slug);
    },

    /** Draw the client's state. Fields being typed in are left alone so incoming changes never eat input. */
    render(state) {
      const detail = state.error?.message;
      setStatus(state.status, detail);
      if (state.status === 'rejected' && detail) this.showError(detail);

      const summary = summarize(state.project);
      if (summary) latest = summary;
      const editable = state.status === 'live' && state.storage?.writable !== false;
      const warning = $('storage-warning');
      const messages = (state.storage?.warnings ?? []).map((code) => code === 'snapshot_dirty' ? 'The snapshot needs a rebuild. The journal data is saved.' : code === 'external_edit_preserved' ? `The app kept the outside snapshot at ${state.storage.warningDetails?.external_edit_preserved?.path ?? '.pcbv/recovery/'}.` : code);
      if (state.storage?.writable === false) messages.push('Board writes are disabled. Reopen the board to recover its journal.');
      warning.textContent = messages.join(' ');
      warning.hidden = messages.length === 0;
      $('terminal-start').disabled = !editable;
      for (const [key, input] of Object.entries(fields)) {
        input.disabled = !editable;
        if (summary && doc.activeElement !== input) input.value = drawn[key] = summary[key] ?? '';
      }
      if (!summary) return;
      board.render(state.project, editable);
      playbook.render(state.project, editable);
      consoleView.render(editable, state.project);
      lastState = state;
      timeline.render(state);
      logicView.render(state.project, editable);
      assistantView.render(state.project, editable);

      $('counts').replaceChildren(...summary.counts.map(({ n, label }) => {
        const item = doc.createElement('li');
        item.textContent = `${n} ${label}`;
        return item;
      }));

      const feed = $('feed');
      feed.replaceChildren(...[...state.feed].reverse().map((event) => {
        const row = doc.createElement('li');
        for (const [className, text] of [['seq', `#${event.seq}`], ['time', clock(event.ts)], ['actor', event.actor], ['what', describeEvent(event, guessName(doc.documentElement.dataset.assistant))]]) {
          const cell = doc.createElement('span');
          cell.className = className;
          cell.textContent = text;
          row.append(cell);
        }
        return row;
      }));
    },
  };
}
