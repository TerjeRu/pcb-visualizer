// The dock: places panels into the four regions from a layout (core/layout.js), draws tab bars and
// panel headings, lets panels be dragged between regions, moved with a menu or opened in their own
// window or put away, finds every panel again through the Panels menu, and keeps the current layout
// saved as a named workspace. Panels are existing elements that get moved around, so the views inside
// them keep their state and listeners.

import { PANELS, PRESETS, REGIONS, activate, attach, detach, locate, move, normalize, putAway, setMode, visiblePanels } from './core/layout.js';
import { dom } from './dom.js';

const REGION_NAMES = { left: 'Left', center: 'Centre', right: 'Right', bottom: 'Bottom' };

// Small drawn icons, so the buttons look the same whatever fonts are installed (text symbols such as
// ⋯ ⠿ ☰ ⧉ come from different fonts and render inconsistently). 16 x 16, drawn in the text colour.
const ICONS = {
  menu: [['circle', { cx: 3.5, cy: 8, r: 1.4 }], ['circle', { cx: 8, cy: 8, r: 1.4 }], ['circle', { cx: 12.5, cy: 8, r: 1.4 }]],
  grip: [5, 8, 11].flatMap((y) => [['circle', { cx: 6, cy: y, r: 1.2 }], ['circle', { cx: 10, cy: y, r: 1.2 }]]),
  stack: [['rect', { x: 2.5, y: 2.5, width: 11, height: 3.5, rx: 1, fill: 'none' }], ['rect', { x: 2.5, y: 10, width: 11, height: 3.5, rx: 1, fill: 'none' }]],
  tabs: [['path', { d: 'M2.5 5.5h4l1-2.5h3l1 2.5h2v8h-11z', fill: 'none' }]],
};

function icon(doc, name) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  for (const [tag, attrs] of ICONS[name]) {
    const node = doc.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.append(node);
  }
  return svg;
}

export function createDock(doc, handlers) {
  const { $, el, options } = dom(doc);
  const panelEl = (name) => $(`panel-${name}`);

  let assistant = 'off';              // the Agent panel exists only while the assistant setting is on
  const norm = (raw) => normalize(raw, { assistant });
  let layout = norm(PRESETS.Learn);
  let store = { current: 'Learn', saved: {} };
  let saveTimer = null;
  const windows = new Map();          // panel -> window handle, opened from this page or found again after a reload
  const watchers = new Map();         // panel -> interval that notices its window closing; one per window
  let openMenu = null;
  let menuOpener = null;              // the button that opened the menu, where focus goes back to
  let dragging = false;
  let settled = false;                // the saved workspace replaced the default layout
  let borrowed = null;                // the layout to give back when a fixed one (the tutorial's) ends; that one is never saved
  let locked = false;                 // no moving, dragging or Panels menu
  const alive = (handle) => Boolean(handle) && !handle.closed;
  const liveHandle = (panel) => (alive(windows.get(panel)) ? windows.get(panel) : null);

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (borrowed) return;
      store = { ...store, saved: { ...store.saved, [store.current]: layout } };
      handlers.saveWorkspaces?.(store);
    }, 400);
  }

  /** Scroll a panel into view and flash it, so a move is visible even into a long stacked column. */
  function reveal(panel) {
    const node = panelEl(panel);
    if (!node || node.hidden || node.closest('#panel-store')) return;
    node.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    node.classList.remove('moved');
    void node.offsetWidth;                 // restart the animation when the same panel moves twice
    node.classList.add('moved');
    setTimeout(() => node.classList.remove('moved'), 1300);
  }

  function setLayout(next, { save = true, show = null } = {}) {
    if (next === layout) return;
    layout = next;
    draw();
    if (show) reveal(show);
    handlers.onLayout?.(layout);
    if (save) scheduleSave();
  }

  /**
   * A layout from a preset or a saved workspace may want panels in their own windows. Windows that are
   * no longer wanted close, missing ones open, and a panel whose window cannot open stays docked, so no
   * panel is left in a window that does not exist.
   */
  function arrange(next) {
    for (const panel of layout.detached) if (!next.detached.includes(panel)) closeWindow(panel);
    let result = next;
    const stayed = [];
    for (const panel of next.detached) {
      if (liveHandle(panel) || launch(panel)) continue;
      result = attach(result, panel);
      stayed.push(PANELS[panel]);
    }
    if (stayed.length) handlers.onStatus?.(`The window could not be opened, so ${stayed.join(', ')} stay${stayed.length === 1 ? 's' : ''} in this window. The browser may have blocked the pop-up.`);
    return result;
  }

  function useWorkspace(name) {
    store = { ...store, current: name };
    setLayout(arrange(norm(store.saved[name] ?? PRESETS[name] ?? PRESETS.Learn)), { save: false });
    handlers.saveWorkspaces?.(store);
    drawWorkspaces();
  }

  function drawWorkspaces() {
    const names = [...new Set([...Object.keys(PRESETS), ...Object.keys(store.saved)])];
    options($('workspace-select'), names.map((name) => ({ value: name, label: name, selected: name === store.current })));
    $('workspace-reset').disabled = !(store.current in PRESETS);
  }

  $('workspace-select').addEventListener('change', (event) => useWorkspace(event.target.value));
  function naming(on) {
    $('workspace-name-form').hidden = !on;
    $('workspace-save').hidden = on;
    $('workspace-reset').hidden = on;
    if (on) { $('workspace-name').value = ''; $('workspace-name').focus(); }
  }
  $('workspace-save').addEventListener('click', () => naming(true));
  $('workspace-name-cancel').addEventListener('click', () => { naming(false); $('workspace-save').focus(); });
  $('workspace-name').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); naming(false); $('workspace-save').focus(); }
  });
  $('workspace-name-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('workspace-name').value.trim().slice(0, 40);
    if (!name) { $('workspace-name').focus(); return; }
    store = { current: name, saved: { ...store.saved, [name]: layout } };
    handlers.saveWorkspaces?.(store);
    drawWorkspaces();
    naming(false);
  });
  $('workspace-reset').addEventListener('click', () => {
    if (store.current in PRESETS) setLayout(arrange(norm(PRESETS[store.current])));
  });

  function closeMenu({ refocus = false } = {}) {
    const opener = menuOpener;
    openMenu?.remove();
    openMenu = null;
    menuOpener = null;
    opener?.setAttribute('aria-expanded', 'false');
    if (refocus) opener?.focus();
  }
  doc.addEventListener('click', (event) => { if (openMenu && !openMenu.contains(event.target)) closeMenu(); });
  doc.addEventListener('keydown', (event) => { if (event.key === 'Escape' && openMenu) closeMenu({ refocus: true }); });

  const focusPanel = (panel) => (doc.querySelector(`.region-tab[data-panel="${panel}"]`) ?? doc.querySelector(`.panel-menu[data-menu-for="${panel}"]`))?.focus();

  /** Arrow keys, Home and End move between the items; Tab closes the menu and carries on from its button. */
  function menuKeys(menu, event) {
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const at = items.indexOf(doc.activeElement);
    const target = { ArrowDown: items[(at + 1) % items.length], ArrowUp: items[(at - 1 + items.length) % items.length], Home: items[0], End: items.at(-1) }[event.key];
    if (target) { event.preventDefault(); target.focus(); }
    else if (event.key === 'Tab') closeMenu({ refocus: true });
  }

  function menuButton(panel) {
    const button = el('button', 'panel-menu icon-button');
    button.append(icon(doc, 'menu'));
    button.type = 'button';
    button.title = `Move ${PANELS[panel]}`;
    button.setAttribute('aria-label', `Move or detach ${PANELS[panel]}`);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.dataset.menuFor = panel;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenu();
      const where = locate(layout, panel);
      const menu = el('div', 'menu');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', `Move ${PANELS[panel]}`);
      menu.addEventListener('keydown', (keyEvent) => menuKeys(menu, keyEvent));
      for (const region of REGIONS) {
        if (where?.region === region) continue;
        const item = el('button', '', `Move to ${REGION_NAMES[region].toLowerCase()}`);
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        item.addEventListener('click', () => {
          closeMenu();
          setLayout(move(layout, panel, region), { show: panel });
          // The move redraws the regions, so the button that opened the menu is gone; carry on from the new one.
          doc.querySelector(`.panel-menu[data-menu-for="${panel}"]`)?.focus();
        });
        menu.append(item);
      }
      const out = el('button', '', 'Open in its own window');
      out.type = 'button';
      out.setAttribute('role', 'menuitem');
      out.addEventListener('click', () => { closeMenu(); openWindow(panel); });
      const away = el('button', '', 'Put away');
      away.type = 'button';
      away.setAttribute('role', 'menuitem');
      away.addEventListener('click', () => { closeMenu(); putPanelAway(panel); });
      menu.append(out, away);
      for (const item of menu.querySelectorAll('button')) item.tabIndex = -1;
      button.after(menu);
      openMenu = menu;
      menuOpener = button;
      button.setAttribute('aria-expanded', 'true');
      menu.querySelector('button')?.focus();
    });
    return button;
  }

  /** Open the window for a panel. Returns false when the browser or shell gave none (a blocked pop-up). */
  function launch(panel) {
    const handle = handlers.openPanelWindow?.(panel) ?? null;
    if (!handle) return false;
    windows.set(panel, handle);
    watch(panel, handle);
    return true;
  }

  function openWindow(panel) {
    if (launch(panel)) { setLayout(detach(layout, panel)); return; }
    handlers.onStatus?.(`The window could not be opened, so ${PANELS[panel]} stays in this window. The browser may have blocked the pop-up.`);
    if (locate(layout, panel)?.detached) setLayout(attach(layout, panel), { show: panel });
  }

  function watch(panel, handle) {
    clearInterval(watchers.get(panel));
    watchers.delete(panel);
    if (typeof handle.closed !== 'boolean') return;      // a handle that cannot report closing is not watched
    const timer = setInterval(() => {
      if (!handle.closed) return;
      clearInterval(timer);
      if (watchers.get(panel) === timer) watchers.delete(panel);
      if (windows.get(panel) !== handle) return;         // a newer window took its place
      windows.delete(panel);
      if (locate(layout, panel)?.detached) setLayout(attach(layout, panel), { show: panel });
    }, 1000);
    watchers.set(panel, timer);
  }

  function closeWindow(panel) {
    const handle = windows.get(panel);
    clearInterval(watchers.get(panel));
    watchers.delete(panel);
    windows.delete(panel);
    try { handle?.close?.(); } catch { /* already closed */ }
  }

  function bringBack(panel) {
    closeWindow(panel);
    setLayout(attach(layout, panel), { show: panel });
  }

  function putPanelAway(panel) {
    setLayout(putAway(layout, panel));
    $('panels-open').focus();                // the way back is in the Panels menu, so focus goes there
  }

  /** Make a panel visible wherever it is: focus its window, return it from away or a lost window, or bring its tab forward. */
  function showPanel(panel) {
    const where = locate(layout, panel);
    if (where?.detached) {
      const handle = liveHandle(panel);
      if (handle) handle.focus?.();
      else bringBack(panel);
      return;
    }
    if (where?.away) { if (!locked) setLayout(attach(layout, panel), { show: panel }); return; }   // a locked layout (the tutorial) keeps put-away panels away
    setLayout(activate(layout, panel));
  }

  const STATE_TEXT = { ...REGION_NAMES };
  const stateOf = (panel) => {
    const where = locate(layout, panel);
    return where?.region ? STATE_TEXT[where.region] : where?.detached ? 'Own window' : 'Put away';
  };

  function panelsMenu() {
    const button = $('panels-open');
    if (button.disabled || locked) return;
    if (menuOpener === button) { closeMenu({ refocus: true }); return; }
    closeMenu();
    const menu = el('div', 'menu panels-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Panels');
    let typed = { text: '', at: 0 };
    menu.addEventListener('keydown', (event) => {
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
        const now = Date.now();
        typed = { text: (now - typed.at > 800 ? '' : typed.text) + event.key.toLowerCase(), at: now };
        const row = [...menu.querySelectorAll('.panels-row')].find((r) => r.dataset.title.toLowerCase().startsWith(typed.text));
        if (row) { event.preventDefault(); row.querySelector('[role="menuitem"]').focus(); }
      } else {
        typed = { text: '', at: 0 };
        menuKeys(menu, event);
      }
    });
    for (const panel of Object.keys(PANELS)) {
      if (panel === 'assistant' && assistant === 'off') continue;
      const where = locate(layout, panel);
      const row = el('div', 'panels-row');
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', `${PANELS[panel]}, ${stateOf(panel)}`);
      row.dataset.panel = panel;
      row.dataset.title = PANELS[panel];
      const action = (label, run) => {
        const item = el('button', '', label);
        item.type = 'button';
        item.tabIndex = -1;
        item.setAttribute('role', 'menuitem');
        item.addEventListener('click', () => { closeMenu(); run(); });
        return item;
      };
      const shown = () => { handlers.onShow?.(panel); focusPanel(panel); };
      const actions = where?.region ? [
        action('Show', () => { setLayout(activate(layout, panel), { show: panel }); shown(); }),
        action('Open in own window', () => { openWindow(panel); button.focus(); }),
        action('Put away', () => putPanelAway(panel)),
      ] : where?.detached ? [
        action('Focus window', () => { showPanel(panel); if (!liveHandle(panel)) shown(); }),
        action('Bring back', () => { bringBack(panel); shown(); }),
      ] : [
        action('Show here', () => { setLayout(attach(layout, panel), { show: panel }); shown(); }),
      ];
      const name = el('span', 'panels-name', PANELS[panel]);
      const state = el('span', 'panels-state', stateOf(panel));
      name.setAttribute('aria-hidden', 'true');
      state.setAttribute('aria-hidden', 'true');
      row.append(name, state, ...actions);
      menu.append(row);
    }
    button.after(menu);
    openMenu = menu;
    menuOpener = button;
    button.setAttribute('aria-expanded', 'true');
    menu.querySelector('[role="menuitem"]')?.focus();
  }

  $('panels-open').addEventListener('click', (event) => { event.stopPropagation(); panelsMenu(); });
  doc.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'p')) return;
    if (doc.body.classList.contains('single-panel') || $('panels-open').disabled || locked) return;
    event.preventDefault();
    if (menuOpener !== $('panels-open')) panelsMenu();
  });

  function dropTarget(node, region) {
    node.addEventListener('dragover', (event) => {
      if (locked) return;
      if (event.dataTransfer?.types?.includes('application/x-pcbv-panel')) {
        event.preventDefault();
        node.classList.add('drop');
      }
    });
    node.addEventListener('dragleave', () => node.classList.remove('drop'));
    node.addEventListener('drop', (event) => {
      node.classList.remove('drop');
      if (locked) return;
      const panel = event.dataTransfer?.getData('application/x-pcbv-panel');
      if (!(panel in PANELS) || (panel === 'assistant' && assistant === 'off')) return;  // dragged from a window that has not heard
      event.preventDefault();
      setLayout(move(layout, panel, region), { show: panel });
    });
  }

  function drawRegion(region) {
    const box = $(`region-${region}`);
    const bar = box.querySelector('.region-bar');
    const body = box.querySelector('.region-body');
    const panels = layout.regions[region];
    const mode = layout.modes[region];
    box.dataset.mode = mode;
    box.classList.toggle('empty', panels.length === 0);

    const tabs = el('div', 'region-tabs');
    if (mode === 'tabs' && panels.length) {
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', `${REGION_NAMES[region]} panels`);
      for (const panel of panels) {
        const tab = el('button', 'region-tab', PANELS[panel]);
        const selected = layout.active[region] === panel;
        tab.type = 'button';
        tab.id = `region-tab-${panel}`;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(selected));
        tab.setAttribute('aria-controls', `panel-${panel}`);
        tab.tabIndex = selected ? 0 : -1;
        tab.draggable = true;
        tab.dataset.panel = panel;
        tab.addEventListener('click', () => { setLayout(activate(layout, panel)); handlers.onShow?.(panel); });
        tab.addEventListener('keydown', (event) => {
          const at = panels.indexOf(panel);
          const next = { ArrowRight: panels[(at + 1) % panels.length], ArrowLeft: panels[(at - 1 + panels.length) % panels.length], Home: panels[0], End: panels.at(-1) }[event.key];
          if (!next) return;
          event.preventDefault();
          setLayout(activate(layout, next));
          handlers.onShow?.(next);
          box.querySelector(`.region-tab[data-panel="${next}"]`)?.focus();
        });
        tab.addEventListener('dragstart', (event) => {
          if (locked) { event.preventDefault(); return; }
          event.dataTransfer.setData('application/x-pcbv-panel', panel);
          event.dataTransfer.effectAllowed = 'move';
        });
        tabs.append(tab);
      }
    }
    if (!panels.length) tabs.append(el('span', 'region-drop', `Drop here: ${REGION_NAMES[region]}`));
    const tools = el('div', 'region-tools');
    if (mode === 'tabs' && layout.active[region]) tools.append(menuButton(layout.active[region]));
    // The icon shows what a click switches to: stacked panels, or tabs.
    const toggle = el('button', 'region-mode icon-button');
    toggle.append(icon(doc, mode === 'tabs' ? 'stack' : 'tabs'));
    toggle.type = 'button';
    toggle.title = mode === 'tabs' ? 'Show these panels stacked' : 'Show these panels as tabs';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.addEventListener('click', () => setLayout(setMode(layout, region, mode === 'tabs' ? 'stack' : 'tabs')));
    tools.append(toggle);
    bar.replaceChildren(tabs, tools);

    const shown = visiblePanels(layout, { assistant });
    for (const panel of panels) {
      const node = panelEl(panel);
      if (node.parentElement !== body) body.append(node);
      node.hidden = !shown.has(panel);
      if (mode === 'tabs') {
        node.setAttribute('role', 'tabpanel');
        node.setAttribute('aria-labelledby', `region-tab-${panel}`);
      } else {
        node.removeAttribute('role');
        node.removeAttribute('aria-labelledby');
      }
      // In stacked mode every panel gets its own heading with a menu and a drag handle.
      let head = node.querySelector(':scope > .panel-head');
      if (mode === 'stack') {
        if (!head) {
          head = el('div', 'panel-head');
          node.prepend(head);
        }
        // The panel's own heading names it, so the corner only holds a grip to drag and the menu.
        const grip = el('span', 'panel-grip');
        grip.append(icon(doc, 'grip'));
        grip.title = `Drag ${PANELS[panel]} to another region`;
        grip.draggable = true;
        grip.ondragstart = (event) => { if (locked) event.preventDefault(); else event.dataTransfer.setData('application/x-pcbv-panel', panel); };
        head.replaceChildren(grip, menuButton(panel));
      } else {
        head?.remove();
      }
    }
    for (const panel of panels) body.append(panelEl(panel));
  }

  function draw() {
    closeMenu();
    if (dragging) endDrag();
    const storeBox = $('panel-store');
    for (const panel of [...layout.detached, ...layout.away]) {
      const node = panelEl(panel);
      if (node.parentElement !== storeBox) storeBox.append(node);
      node.removeAttribute('role');
      node.removeAttribute('aria-labelledby');
    }
    if (assistant === 'off') {                // not in any region: nothing of it can be reached or focused
      const node = panelEl('assistant');
      if (node.parentElement !== storeBox) storeBox.append(node);
    }
    for (const region of REGIONS) drawRegion(region);
    const board = $('board-panel');
    for (const region of REGIONS) board.classList.toggle(`has-${region}`, layout.regions[region].length > 0);
    $('board-empty').hidden = REGIONS.some((region) => layout.regions[region].length > 0);
  }

  for (const region of REGIONS) {
    dropTarget($(`region-${region}`).querySelector('.region-bar'), region);
    dropTarget($(`region-${region}`).querySelector('.region-body'), region);
  }

  /** While a panel is dragged, empty regions are laid out like full ones so they can take the drop. */
  function showDropZones(on) {
    const board = $('board-panel');
    board.classList.toggle('dragging', on);
    for (const region of REGIONS) board.classList.toggle(`has-${region}`, on || layout.regions[region].length > 0);
  }
  doc.addEventListener('dragstart', (event) => {
    if (!event.target.closest?.('#board-panel .region-tab, #board-panel .panel-grip')) return;
    if (locked) { event.preventDefault(); return; }
    dragging = true;
    // Chrome and WebKit end a drag at once when the layout under it changes inside dragstart.
    doc.defaultView.setTimeout(() => { if (dragging) showDropZones(true); }, 0);
  });
  // A drop redraws the dock and so removes the dragged tab; its dragend never reaches the document, which is why draw() ends a drag as well.
  doc.addEventListener('dragend', () => { if (dragging) endDrag(); });
  function endDrag() {
    dragging = false;
    showDropZones(false);
  }
  $('board-empty-panels').addEventListener('click', (event) => { event.stopPropagation(); panelsMenu(); });

  return {
    /** Load saved workspaces from the service and apply the current one. */
    async start() {
      try {
        const loaded = await handlers.loadWorkspaces?.();
        if (loaded && typeof loaded === 'object') store = { current: loaded.current || 'Learn', saved: loaded.saved ?? {} };
      } catch { /* keep the defaults */ }
      layout = norm(store.saved[store.current] ?? PRESETS[store.current] ?? PRESETS.Learn);
      settled = true;
      // A detached panel stays detached only if its window is still there; the rest come home, unsaved,
      // so the saved workspace keeps its design for the next time windows are opened.
      for (const panel of [...layout.detached]) {
        const found = await Promise.resolve(handlers.findPanelWindow?.(panel)).catch(() => null);
        if (alive(found)) { windows.set(panel, found); watch(panel, found); continue; }
        layout = attach(layout, panel);
        handlers.onPanelHome?.(panel);      // a window this page could not reach must stop taking work for it
      }
      handlers.onSettled?.();
      drawWorkspaces();
      $('panels-open').disabled = false;
      draw();
      handlers.onLayout?.(layout);
    },
    /** Make a panel visible: bring it to the front of its region, or focus its window. A panel whose window is gone, or that was put away, comes back to where it was. */
    show: showPanel,
    /** 'remote' when the panel lives in another window (now focused), else 'here' (now visible). */
    route(panel) {
      const remote = locate(layout, panel)?.detached && Boolean(liveHandle(panel));
      this.show(panel);
      return remote ? 'remote' : 'here';
    },
    /** The panel in front in the region `panel` is docked in, when that is another panel; else null. */
    activeBeside(panel) {
      const region = locate(layout, panel)?.region;
      const front = region ? layout.active[region] : null;
      return front && front !== panel ? front : null;
    },
    isDocked: (panel) => Boolean(locate(layout, panel)?.region),
    /** True for a panel this window owns, docked or put away; its actions are run here. */
    holds: (panel) => Boolean(locate(layout, panel)?.region || locate(layout, panel)?.away),
    /** True once the saved workspace is in place; before that the layout is only the default. */
    settled: () => settled,
    bringBack,
    isVisible(panel) { return visiblePanels(layout, { assistant }).has(panel); },
    /**
     * The assistant setting changed. Off: the Agent panel leaves the layout and its window closes. On: it
     * comes back at the end of the right-hand tabs (choosing a preset again puts it in that preset's place).
     * Not saved: a saved workspace keeps its design, and the layout is made right again on every load.
     */
    setAssistant(value) {
      const next = value === 'on' ? 'on' : 'off';
      if (next === assistant) return;
      assistant = next;
      if (!settled) return;
      setLayout(arrange(norm(layout)), { save: false });
    },
    layout: () => layout,
    draw,
    /** No moving, dragging or Panels menu while a fixed layout is on. */
    lock(on) { locked = Boolean(on); },
    /** Show a fixed layout that is never saved. The layout in place is kept, windows included, for `restore`. */
    lend(next) {
      if (!borrowed) borrowed = layout;
      setLayout(arrange(norm(next)), { save: false });
    },
    /** Give the layout back, and reopen the windows it had. */
    restore() {
      if (!borrowed) return;
      const back = borrowed;
      borrowed = null;
      setLayout(arrange(norm(back)), { save: false });
    },
  };
}

/** A window that shows one panel only: everything else is hidden. */
export function showSinglePanel(doc, panel) {
  if (!(panel in PANELS)) return false;
  const board = doc.getElementById('board-panel');
  const node = doc.getElementById(`panel-${panel}`);
  for (const region of doc.querySelectorAll('.region')) region.remove();
  board.classList.add('single');
  board.prepend(node);
  node.hidden = false;
  doc.title = `pcbv · ${PANELS[panel]}`;
  doc.body.classList.add('single-panel');
  return true;
}
