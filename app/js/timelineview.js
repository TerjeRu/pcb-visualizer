// The Timeline tab: everything that happened on the board, newest first, grouped by day, with
// filters. Entries with a target jump to it (a photo, a header, a callout, a playbook step); console
// sessions open their captured log right here. Built from the full journal plus, while git is on, the
// data repo's commits for this board. Text from the board is only ever set with textContent.

import { KINDS, buildTimeline, byDay } from './core/timeline.js';
import { guessName } from './core/format.js';
import { setGuided } from './guidance.js';
import { dom } from './dom.js';

export function createTimelineView(doc, handlers) {
  const { $, el, screenRows } = dom(doc);

  let events = [];
  let commits = [];
  let playbooks = [];
  let project = null;
  let projectSeq = 0;                // the journal position `project` was taken at
  let loadedSeq = 0;
  let loading = null;
  let visible = false;
  let generation = 0;                // bumped by reset(), so answers for the previous board are dropped
  let commitsLoaded = false;
  const hidden = new Set();          // kinds filtered out

  const gitOn = () => doc.documentElement.dataset.git === 'on';

  function drawChips() {
    $('timeline-filters').replaceChildren(...KINDS.filter(([kind]) => kind !== 'commit' || gitOn()).map(([kind, label]) => {
      const chip = el('button', 'chip', label);
      chip.type = 'button';
      chip.dataset.kind = kind;
      chip.setAttribute('aria-pressed', String(!hidden.has(kind)));
      chip.addEventListener('click', () => {
        if (hidden.has(kind)) hidden.delete(kind); else hidden.add(kind);
        chip.setAttribute('aria-pressed', String(!hidden.has(kind)));
        draw();
      });
      return chip;
    }));
  }
  drawChips();
  $('timeline-refresh').addEventListener('click', () => { if (gitOn()) loadCommits(); });
  $('timeline-log-close').addEventListener('click', () => { $('timeline-log').hidden = true; });

  async function catchUp(seq) {
    if (loading || seq <= loadedSeq) return;
    const from = loadedSeq;
    const started = generation;
    loading = handlers.loadEvents(from)
      .then((result) => {
        if (started !== generation) return;
        const fresh = (result.events ?? []).filter((e) => e.seq > loadedSeq);
        events = [...events, ...fresh];
        loadedSeq = Math.max(loadedSeq, result.seq ?? loadedSeq);
        draw();
      })
      .catch((error) => { if (started === generation) $('timeline-status').textContent = `Could not load the history: ${error.message}`; })
      .finally(() => {
        if (started !== generation) return;
        loading = null;
        if (project && projectSeq > loadedSeq) catchUp(projectSeq);
      });
  }

  async function loadCommits() {
    if (!gitOn()) return;
    const started = generation;
    commitsLoaded = true;
    let loaded;
    let failed = false;
    try {
      loaded = (await handlers.loadCommits()) ?? [];
    } catch {
      loaded = [];
      failed = true;
    }
    if (started !== generation) return;
    if (failed) commitsLoaded = false;   // try again the next time the timeline is shown
    commits = loaded;
    draw();
  }

  async function openLog(target, title) {
    const started = generation;
    const box = $('timeline-log');
    box.hidden = false;
    $('timeline-log-title').textContent = title;
    $('timeline-log-path').textContent = target.path;
    const out = $('timeline-log-output');
    out.replaceChildren(el('div', '', 'Loading…'));
    try {
      const text = await handlers.loadCaptureLog(target.path);
      if (started !== generation) return;
      out.replaceChildren(...screenRows(text));
    } catch (error) {
      if (started === generation) out.replaceChildren(el('div', 'ln-error', `Could not load the log: ${error.message}`));
    }
    box.scrollIntoView?.({ block: 'nearest' });
  }

  function draw() {
    if (!visible) return;
    const entries = buildTimeline({ events, project, commits, playbooks, guess: guessName(doc.documentElement.dataset.assistant) }).filter((e) => !hidden.has(e.kind));
    const status = $('timeline-status');
    if (entries.length) status.textContent = '';
    else if (events.length) status.textContent = 'Nothing matches these filters.';
    else setGuided(status, `Nothing has happened on this board yet. Photos, markers${gitOn() ? ', captures and commits' : ' and captures'} appear here as you work.`, 'No events.');
    $('timeline-list').replaceChildren(...byDay(entries).map(({ day, entries: dayEntries }) => {
      const section = el('section', 'tl-day');
      section.append(el('h4', '', day));
      const list = el('ol', 'tl-entries');
      for (const entry of dayEntries) {
        const item = el('li', `tl-entry tl-${entry.kind}`);
        const time = new Date(entry.ts);
        item.append(el('span', 'tl-time', Number.isNaN(time.getTime()) ? '' : time.toTimeString().slice(0, 5)));
        const body = el('div', 'tl-body');
        if (entry.target) {
          const link = el('a', 'tl-title', entry.title);
          link.href = '#';
          link.addEventListener('click', (event) => {
            event.preventDefault();
            if (entry.target.kind === 'capture') openLog(entry.target, entry.title);
            else handlers.onJump(entry.target);
          });
          body.append(link);
        } else {
          body.append(el('span', 'tl-title', entry.title));
        }
        if (entry.detail) body.append(el('span', 'tl-detail', entry.detail));
        if (entry.actor && entry.actor !== 'web') body.append(el('span', 'tl-actor', entry.actor));
        item.append(body);
        list.append(item);
      }
      section.append(list);
      return section;
    }));
  }

  return {
    setPlaybooks(list) { playbooks = Array.isArray(list) ? list : []; draw(); },
    /** Called on every client state change; fetches events the timeline has not seen yet while visible. */
    render(state) {
      project = state.project ?? null;
      projectSeq = state.seq ?? 0;
      if (visible) catchUp(state.seq);
      draw();
    },
    show(state) {
      visible = true;
      if (!commitsLoaded) loadCommits();
      if (state) this.render(state);
    },
    /** Called when the git setting changes: Off takes the Commits chip and the commits away, On brings them back. */
    setGit() {
      if (!gitOn()) {
        hidden.delete('commit');
        commits = [];
        commitsLoaded = false;
      }
      drawChips();
      if (gitOn() && visible && !commitsLoaded) loadCommits();
      draw();
    },
    hide() { visible = false; },
    reset() {
      generation += 1;
      events = [];
      commits = [];
      commitsLoaded = false;
      loading = null;
      loadedSeq = 0;
      $('timeline-log').hidden = true;
      $('timeline-list').replaceChildren();
    },
  };
}
