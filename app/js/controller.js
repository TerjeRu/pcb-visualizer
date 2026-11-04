// What the app does, separate from how it looks: sign in, choose a board, create one, save edits.
// The DOM lives in ui.js and is passed in as `view`, so this file can be tested without a browser.

import { ClientError } from './client.js';
import { newMarkerEvent } from './core/schema.js';
import { PANELS } from './core/layout.js';
import { REFUSED } from './core/tutorial/policy.js';
import { forgetToken, resolveSession, storeToken } from './session.js';
import { TUTORIAL_SLUG, createTutorialControl } from './tutorialcontrol.js';

const LOST_SIGN_IN = 'This window lost its sign-in. Reopen it from the main window, or run `pcbv open`.';

const BOARD_KEY = 'pcbv.board';

export function createController({ env, view, api, makeClient, baseUrl }) {
  let token = null;
  let client = null;
  let unsubscribe = null;
  let boards = [];
  let welcomed;                   // from the saved settings; undefined until they arrive
  let settings = null;            // the latest saved settings
  let startChecked = false;       // the first settings of this page load decide whether to go back into the tutorial
  let welcomeReturn = null;       // the board that was open when Settings showed the Welcome
  let currentSlug = null;
  let serialSession = null;
  let boardGeneration = 0;        // bumped whenever the board on screen stops, so late answers can be told apart
  const photos = new Map();       // asset path -> Promise of an object URL, for the board on screen
  const figures = new Map();      // wiki figure file -> Promise of an object URL, kept for the session
  const urls = env.urls ?? globalThis.URL;
  const openedWindows = new WeakSet();   // panel windows this one opened; only they may ask for a code

  // Arguments every call to the service carries: the address and token, and for a board the slug on screen.
  const withToken = (extra = {}) => ({ baseUrl, token, ...extra });
  const onBoard = (extra = {}) => withToken({ slug: currentSlug, ...extra });

  const remember = (slug) => { if (slug === TUTORIAL_SLUG) return; try { env.storage.setItem(BOARD_KEY, slug); } catch { /* optional */ } };
  const remembered = () => { try { return env.storage.getItem(BOARD_KEY); } catch { return null; } };

  function stopBoard() {
    boardGeneration += 1;
    serialSession = null;
    unsubscribe?.();
    client?.close();
    unsubscribe = null;
    client = null;
    for (const pending of photos.values()) pending.then((url) => url && urls.revokeObjectURL(url), () => {});
    photos.clear();
  }

  const failed = (error, fallback) => {
    if (error.status === 401) signedOut('The service did not accept this token. Run pcbv open to get a fresh one.');
    else {
      if (['outcome_unknown', 'commit_unknown'].includes(error.code)) client?.refresh?.();
      view.showError(error instanceof ClientError || error.message ? error.message : fallback);
    }
  };

  const tutorial = createTutorialControl({
    api, view, storage: env.storage,
    hooks: {
      withToken: () => withToken(),
      saveSetting: (patch) => saveSetting(patch),
      failed: (error, fallback) => failed(error, fallback),
      currentSlug: () => currentSlug,
      client: () => client,
      settings: () => settings,
      openPractice: () => selectBoard(TUTORIAL_SLUG, { practice: true }),
      closed: (previous) => backToBoards(previous),
      send: (event) => send(event),
      closeSerial: () => api.serialClose(onBoard()),
      stopVdev: () => api.vdevStop(withToken()),
      readCapture: (path) => api.fetchFile(onBoard({ path })),
    },
  });
  const refuse = () => Promise.reject(new Error(REFUSED));

  /** The tutorial ended: the board that was open comes back, else the one a fresh start would pick, else the empty page. */
  function backToBoards(previous) {
    const slug = [previous, remembered(), boards[0]].find((candidate) => candidate && boards.includes(candidate));
    if (slug) { view.setBoards(boards, slug); selectBoard(slug); return; }
    stopBoard();
    currentSlug = null;
    view.setBoards(boards, null);
    view.showNoBoards();
  }

  /**
   * Run a call for the board on screen. An answer or failure that arrives after another board was
   * chosen is dropped, so it cannot show an error or change the view of the new board. A rejected
   * token still signs out, since it holds for every board.
   */
  async function forBoard(call, fallback, onFail = null) {
    const started = boardGeneration;
    try {
      const result = await call();
      return started === boardGeneration ? result : onFail;
    } catch (error) {
      if (started !== boardGeneration && error.status !== 401) return onFail;
      failed(error, fallback);
      return onFail;
    }
  }

  /** Send one edit. Resolves true when stored; shows the reason and redraws from service state otherwise. */
  async function send(event) {
    if (!client) return false;
    const mine = client;
    if (!tutorial.permit(event)) { view.render(mine.state); return false; }
    const stored = await forBoard(async () => { await mine.apply(event); return true; }, 'Could not save that change.', false);
    if (!stored && client === mine) view.render(mine.state);
    return stored;
  }

  function signedOut(message) {
    tutorial.abandon();
    stopBoard();
    forgetToken(env.storage);
    token = null;
    view.showTokenPanel(message);
  }

  async function loadBoards(preferred) {
    try {
      await api.health?.({ baseUrl });
      boards = await api.listBoards(withToken());
    } catch (error) {
      if (error.status === 401) return signedOut('The service did not accept this token. Run pcbv open to get a fresh one.');
      view.showTokenPanel(`Could not reach the service: ${error.message}`);
      return undefined;
    }
    loadPlaybooks();
    loadSettings();
    view.startLayout?.();
    const choice = [preferred, remembered(), boards[0]].find((slug) => slug && boards.includes(slug)) ?? null;
    view.setBoards(boards, choice);
    if (choice) selectBoard(choice);
    else { stopBoard(); view.showNoBoards(); }
    return undefined;
  }

  function applySettings(next) {
    settings = next;
    welcomed = next?.welcomed;
    view.setWelcome?.({ welcomed, dataFolder: next?.data_folder });
    view.setTutorial?.({ state: next?.tutorial, step: next?.tutorialStep });
    // A reload or a restarted service in a window that was inside the tutorial goes straight back into it.
    const first = !startChecked;
    startChecked = true;
    if (first && next?.tutorial === 'started' && !env.single && tutorial.wasRunning()) tutorial.start({ resume: true });
    view.setGuidance?.(next?.guidance);
    view.setTheme?.(next?.theme);
    view.setAssistant?.(next?.assistant);
    view.setGit?.(next?.git);
  }

  async function saveSetting(patch) {
    applySettings(await api.saveSettings(withToken({ data: patch })));
  }

  async function loadSettings() {
    try { applySettings(await api.getSettings(withToken())); }
    catch { applySettings({ guidance: 'guided', theme: 'system', assistant: 'off', git: 'off', welcomed: true }); }
  }

  /** Playbooks are re-read on every sign-in, so an edited file in ~/hw/playbooks shows up on reload. */
  async function loadPlaybooks() {
    try {
      const { playbooks, problems } = await api.listPlaybooks(withToken());
      view.setPlaybooks(playbooks, problems);
    } catch (error) {
      view.setPlaybooks([], [{ file: 'service', message: `Could not load playbooks: ${error.message}` }]);
    }
  }

  /** Opening any board ends the first-start Welcome. A failed save leaves it to show again next time. */
  function endWelcome() {
    if (welcomed !== false) return;
    welcomed = true;
    api.saveSettings(withToken({ data: { welcomed: true } })).then(applySettings).catch(() => { welcomed = false; });
  }

  function selectBoard(slug, { practice = false } = {}) {
    if (tutorial.active() && !practice) return;
    if (!practice) endWelcome();
    stopBoard();
    currentSlug = slug;
    remember(slug);
    view.showBoardPanel();
    view.boardChanged?.(slug);
    client = makeClient({ baseUrl, token, slug, onSerial: (message) => {
      if (slug !== currentSlug) return;
      if (message.op === 'serial') serialSession = message.state ?? null;
      view.serialMessage(message);
    },
      onSettings: applySettings });
    unsubscribe = client.subscribe((state) => {
      view.render(state);
      if (practice) tutorial.stateChanged(state);
      if (state.status === 'rejected' && state.error?.code === 4401) {
        signedOut('The service did not accept the token. Run pcbv open to get a fresh one.');
      }
    });
    view.setBoards(practice ? [...boards, slug] : boards, slug);
    client.connect();
  }

  return {
    async start() {
      const session = resolveSession(env);
      token = session.token;
      let code = session.code;
      if (!code && !token && env.requestCode) {
        code = await env.requestCode();
        if (!code) { view.showTokenPanel(LOST_SIGN_IN); return; }
      }
      if (code) {
        try {
          token = await api.redeemCode({ baseUrl, code });
          storeToken(env.storage, token);
        } catch (error) {
          token = null;
          view.showTokenPanel(error.status === 401 ? 'That sign-in code has expired or was already used. Run `pcbv open` again.' : `Could not sign in: ${error.message}`);
          return;
        }
      }
      if (!token) {
        view.showTokenPanel('Open this app with `pcbv open`, or paste the token from the service file.');
        return;
      }
      await loadBoards(session.board ?? env.boardFromQuery ?? null);
    },

    async submitToken(text) {
      if (!storeToken(env.storage, text)) {
        view.showTokenPanel('That does not look like a token.');
        return;
      }
      token = text.trim();
      await loadBoards(null);
    },

    selectBoard,

    async createBoard(name) {
      const clean = String(name ?? '').trim();
      if (!clean) { view.showError('Give the board a name first.'); return; }
      try {
        const created = await api.createBoard(withToken({ name: clean }));
        await loadBoards(created.slug);
      } catch (error) {
        if (error.status === 401) signedOut('The service did not accept this token. Run pcbv open to get a fresh one.');
        else {
          if (error.code === 'outcome_unknown') await loadBoards(null);
          view.showError(error.message);
        }
      }
    },

    /** Save changes to name, device and notes. Only fields that actually changed are sent. */
    async saveDetails({ name, device, notes }) {
      const project = client?.state.project;
      if (!project) return;
      const wanted = { name: String(name ?? '').trim(), device: String(device ?? '').trim(), notes: String(notes ?? '') };
      if (!wanted.name) { view.showError('A board needs a name.'); view.render(client.state); return; }
      const patch = {};
      for (const key of ['name', 'device', 'notes']) {
        if (wanted[key] !== (project.meta[key] ?? '')) patch[key] = wanted[key];
      }
      if (!Object.keys(patch).length) return;
      if (!tutorial.permit({ type: 'project/metaUpdated', patch })) { view.render(client.state); return; }
      const mine = client;
      const started = boardGeneration;
      try {
        await mine.apply({ type: 'project/metaUpdated', patch });
      } catch (error) {
        if (started !== boardGeneration) return;
        view.showError(error instanceof ClientError ? error.message : 'Could not save that change.');
        view.render(mine.state);   // put the fields back to what the service has
      }
    },

    send,

    listSerialPorts: () => api.listSerialPorts(withToken()),
    vdevStatus: () => api.vdevStatus(withToken()),
    startVdev: async () => {
      if (!tutorial.permitAction('vdev-start')) return refuse();
      const status = await api.vdevStart(withToken());
      tutorial.vdevStarted();
      return status;
    },
    stopVdev: () => api.vdevStop(withToken()),
    loadEvents: (since) => api.getEvents(onBoard({ since })),
    loadCommits: () => api.getCommits(onBoard()),
    loadCaptureLog: async (path) => (await api.fetchFile(onBoard({ path }))).text(),

    openSerial: (port, baud) => !tutorial.permitAction('serial-open') ? false : forBoard(async () => { await api.serialOpen(onBoard({ port, baud })); return true; }, 'Could not open the port.', false),
    detectBaud: (port) => !tutorial.permitAction('serial-detect') ? null : forBoard(() => api.serialDetect(onBoard({ port })), 'Could not test the speeds.'),
    closeSerial: () => forBoard(() => api.serialClose(onBoard()), 'Could not close the port.'),

    /** {line, confirm} or {key}. Resolves {sent}, {confirm: true, message} when the service wants confirmation, or null. */
    async writeSerial(payload, slug = currentSlug) {
      if (!tutorial.permitAction('serial-write')) return null;
      const started = boardGeneration;
      try {
        const result = await api.serialWrite(withToken({ slug, payload }));
        return started === boardGeneration ? result : null;
      } catch (error) {
        if (started !== boardGeneration && error.status !== 401) return null;
        if (error.code === 'confirm_required') return { confirm: true, message: error.message };
        failed(error, 'Could not send that.');
        return null;
      }
    },

    /** Where the Terminal panel connects. The token goes in the first message, never in the URL. */
    terminalTarget() {
      if (!currentSlug || client?.state.storage?.writable === false) return null;
      const url = `${baseUrl.replace(/^http/, 'ws')}/api/boards/${encodeURIComponent(currentSlug)}/terminal`;
      return { url, token };
    },

    importLogic: (file, name, samplerate) => !tutorial.permitAction('logic-import') ? null : forBoard(() => api.importLogic(onBoard({ file, name, samplerate })), 'Could not import that capture.'),
    logicEdges: (id, start, end, bins) => api.logicEdges(onBoard({ id, start, end, bins })),
    logicDecode: (id, channel, baud) => !tutorial.permitAction('logic-decode') ? null : forBoard(() => api.logicDecode(onBoard({ id, channel, baud })), 'Could not decode.'),
    logicCompare: (id, channel, other) => !tutorial.permitAction('logic-compare') ? null : forBoard(() => api.logicCompare(onBoard({ id, channel, other })), 'Could not compare.'),

    // The bench assistant. Errors go back to the panel, which shows them next to the question.
    assistantGet: () => api.assistantGet(withToken()),
    assistantSettings: (settings) => api.assistantSettings(withToken({ settings })),
    assistantKey: (profile, key) => api.assistantKey(withToken({ profile, key })),
    assistantTest: (profile) => api.assistantTest(withToken({ profile })),
    assistantChat: (body) => api.assistantChat(onBoard({ body })),
    assistantConversation: () => api.assistantConversation(onBoard()),
    assistantReset: () => api.assistantReset(onBoard()),
    assistantProposals: () => api.assistantProposals(onBoard()),
    serialIdentity: () => serialSession ? { ...serialSession } : null,
    assistantDecide: (id, action, session) => {
      const started = boardGeneration;
      return api.assistantDecide(withToken({ slug: session?.board ?? currentSlug, id, action, sessionId: session?.captureId })).catch((error) => {
        if (started === boardGeneration && ['outcome_unknown', 'commit_unknown'].includes(error.code)) client?.refresh?.();
        throw error;
      });
    },

    /** Guided or Expert for the whole app. Shown at once; put back to the saved level if saving fails. */
    async setGuidance(level) {
      view.setGuidance?.(level);
      try { await api.saveSettings(withToken({ data: { guidance: level } })); }
      catch (error) { failed(error, 'Could not save the setting.'); await loadSettings(); }
    },

    /** System, light or dark, for every window of the app. Saved like the guidance level. */
    async setTheme(theme) {
      view.setTheme?.(theme);
      try { await api.saveSettings(withToken({ data: { theme } })); }
      catch (error) { failed(error, 'Could not save the setting.'); await loadSettings(); }
    },

    /**
     * Turn the assistant or git on or off. Unlike guidance and theme this waits for the service, which can
     * refuse (git before its local checks pass); the error goes back to the Settings dialog to show.
     */
    setSetting: saveSetting,
    benchCheck: () => api.benchCheck(withToken()),

    /** The Welcome's Skip button. */
    skipWelcome: () => saveSetting({ welcomed: true, ...(settings?.tutorial === 'new' ? { tutorial: 'skipped' } : {}) }),

    /**
     * Settings, "Show the welcome again": the Welcome in place of the board panel. The saved setting stays. The
     * open board stays connected, so a wiki page opened from the Welcome shows the panels live; the board
     * list reads "Choose a board", so picking that board again, or Back, reopens it.
     */
    showWelcome() {
      if (currentSlug) welcomeReturn = currentSlug;
      view.setBoards(boards, null);
      view.showWelcome({ back: boards.length > 0 });
    },

    /** The Welcome's Back to my boards: the board that was open, else the one a fresh start would pick. */
    backFromWelcome() {
      const slug = [welcomeReturn, remembered(), boards[0]].find((s) => s && boards.includes(s));
      welcomeReturn = null;
      if (!slug) return;
      view.setBoards(boards, slug);
      selectBoard(slug);
    },

    startTutorial: (options) => (env.single ? Promise.resolve(false) : tutorial.start(options)),
    leaveTutorial: () => tutorial.leave(),
    askLeaveTutorial: () => tutorial.askLeave(),
    tutorialNext: () => tutorial.next(),
    tutorialBack: () => tutorial.back(),
    tutorialAnswer: (value) => tutorial.answer(value),
    tutorialFinishCreate: () => tutorial.finishCreate(),
    /** Photo zoom is view state, not an event; the tutorial's step 2 asks to be told. */
    noteZoom: () => tutorial.noteZoom(),
    /** What the Console, Logic and Export views saw, for the tutorial's checks. */
    noteConsole: (event) => tutorial.noteConsole(event),
    noteLogic: (event) => tutorial.noteLogic(event),
    noteExport: () => tutorial.noteExport(),
    /** The Header panel's selected pin is where the tutorial's red probe goes. */
    notePin: (index) => tutorial.notePin(index),
    benchPower: (on) => tutorial.benchPower(on),
    benchCycle: () => tutorial.benchCycle(),
    benchMode: (mode) => tutorial.benchMode(mode),
    benchProbe: (pin) => tutorial.benchProbe(pin),
    benchWire: (line, pin) => tutorial.benchWire(line, pin),
    benchRecord: () => tutorial.benchRecord(),
    /** The saved tutorial state, for the wiki link and the Settings section. */
    tutorialInfo: () => ({ state: settings?.tutorial, step: settings?.tutorialStep, active: tutorial.active(), canStart: !env.single }),
    gitStatus: () => api.gitStatus(withToken()),
    gitSetup: (body) => api.gitSetup(withToken({ body })),

    loadWorkspaces: () => api.getWorkspaces(withToken()),
    saveWorkspaces: (data) => api.saveWorkspaces(withToken({ data })).catch((error) => failed(error, 'Could not save the layout.')),

    /**
     * A window showing one panel of the current board; `generation` is the main window's board counter,
     * which the new window starts from. The desktop shell provides its own windows. Without a sign-in or
     * a board there is nothing to show, and no empty window is opened for it.
     */
    openPanelWindow(panel, generation = 0) {
      if (!token || !currentSlug) return null;
      const getCode = () => api.mintCode(withToken());
      if (env.shell?.openPanel) return env.shell.openPanel(panel, currentSlug, getCode, PANELS[panel] ?? panel, generation);
      const url = `${env.location.pathname}?panel=${encodeURIComponent(panel)}&board=${encodeURIComponent(currentSlug)}&gen=${generation}`;
      // Opened empty inside the click, so a pop-up blocker allows it; the code arrives a moment later.
      const win = env.open?.('', `pcbv-${panel}`, 'popup,width=960,height=720') ?? null;
      if (win) {
        openedWindows.add(win);
        getCode().then((code) => { if (!win.closed) win.location.href = `${url}#code=${code}`; }, (error) => { win.close(); failed(error, 'Could not open the window.'); });
      }
      return win;
    },

    /** The handle of a panel window the desktop shell still has, after the main window reloaded. */
    findShellWindow: (panel) => env.shell?.find?.(panel) ?? null,

    /** A panel window whose storage lost the token asks the window that opened it for a fresh code. */
    async answerCodeRequest(event) {
      if (event.origin !== env.location.origin || event.data?.type !== 'pcbv:code-request' || !openedWindows.has(event.source) || !token) return;
      try { event.source.postMessage({ type: 'pcbv:code', code: await api.mintCode(withToken()) }, env.location.origin); }
      catch { /* the panel times out and shows how to reopen */ }
    },

    loadWikiIndex: () => api.listWiki(withToken()),
    loadWikiPage: (name) => api.getWikiPage(withToken({ name })),

    /** Object URL for a wiki figure, fetched once per session. */
    loadWikiFigure(file) {
      if (!figures.has(file)) {
        figures.set(file, api.fetchWikiFigure(withToken({ file })).then((blob) => urls.createObjectURL(blob), (error) => {
          figures.delete(file);       // a figure added after a failed load shows on the next visit
          throw error;
        }));
      }
      return figures.get(file);
    },

    /** Object URL for a photo of the board on screen. Fetched once per board visit. */
    loadPhoto(path) {
      if (!photos.has(path)) {
        const slug = currentSlug;
        photos.set(path, api.fetchFile(withToken({ slug, path })).then((blob) => urls.createObjectURL(blob)));
      }
      return photos.get(path);
    },

    /** Upload a photo; resolves with the new asset id, or null after showing why it failed. */
    async uploadPhoto(file, side) {
      if (!currentSlug || client?.state.storage?.writable === false || !tutorial.permitAction('upload')) return null;
      const label = String(file?.name ?? '').replace(/\.[^.]*$/, '').slice(0, 40);
      const uploaded = await forBoard(() => api.uploadPhoto(onBoard({ file, side, label: label || side })), 'Could not add that photo.');
      return uploaded?.event.asset.id ?? null;
    },

    /** Export the board on screen; resolves with what the service wrote. Errors are thrown to the caller. */
    exportBoard: (formats, redact) => (tutorial.permitAction('export') ? api.exportBoard(onBoard({ formats, redact })) : refuse()),

    /** New box marker with its own header. Resolves with the marker id, or null. */
    async addMarker(assetId, rect) {
      const count = client?.state.project?.markers.length ?? 0;
      const event = newMarkerEvent({ assetId, rect, colorIndex: count });
      return (await send(event)) ? event.marker.id : null;
    },

    stop: stopBoard,
  };
}
