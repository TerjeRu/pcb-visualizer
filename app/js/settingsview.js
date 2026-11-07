// The Settings dialog: the theme, the assistant switch, and the git switch with its setup steps.
// The assistant's profile form lives in this dialog too, but assistantview.js owns it. Text from the
// service (paths, addresses, command output) is only set with textContent.

import { dom } from './dom.js';
import { drawChecks } from './benchlist.js';
import { createLinkOpener } from './core/links.js';

const STEPS = ['check', 'init', 'ignore', 'remote', 'sync'];
const WAITING = {
  remote: 'The app checks the address with GitHub and git. This can take up to 30 seconds.',
  sync: 'The app syncs the board files. This can take up to a minute.',
};

export function createSettingsView(doc, handlers) {
  const { $, el } = dom(doc);
  const dialog = $('settings-dialog');
  let pendingReplace = null;   // {old, new} while the person is asked whether to replace the remote address
  let busy = false;
  let generation = 0;          // a status answer for an earlier opening of the dialog is dropped

  // The page carries no web addresses of its own: a link to another site is given as data-external and
  // made here the way the wiki makes one, so the desktop shell opens it in the system browser.
  const openExternal = createLinkOpener(doc.defaultView);
  for (const link of doc.querySelectorAll('#settings-dialog a[data-external]')) {
    link.href = link.dataset.external;
    link.rel = 'noopener noreferrer';
    if (openExternal) link.addEventListener('click', (event) => { event.preventDefault(); openExternal(link.href); });
    else link.target = '_blank';
  }

  const modal = typeof dialog.showModal === 'function';
  const SECTION_FOCUS = { git: 'settings-git', assistant: 'settings-assistant' };
  /** `section` ('git' or 'assistant') puts focus on that section's switch, which scrolls it into view. */
  function open(section) {
    const target = $(SECTION_FOCUS[section] ?? 'settings-close');
    if (dialog.open) { target.focus(); return; }
    if (modal) dialog.showModal(); else dialog.setAttribute('open', '');
    handlers.onOpen?.();
    refreshGit();
    loadChecks();
    drawTutorial();
    $('settings-welcome-note').textContent = '';
    target.focus();
  }
  function close() {
    if (!dialog.open) return;
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
    $('settings-open').focus();
  }
  let checksGeneration = 0;    // a check result for an earlier request is dropped
  async function loadChecks() {
    const started = ++checksGeneration;
    try {
      const checks = await handlers.benchCheck();
      if (started === checksGeneration) drawChecks(doc, $('settings-checks'), checks);
    } catch (error) {
      if (started === checksGeneration) drawChecks(doc, $('settings-checks'), null, error.message);
    }
  }
  $('settings-checks-again').addEventListener('click', loadChecks);
  let tutorial = { state: 'new', step: 1 };
  /** The Tutorial section: where the person is, and the buttons that start, resume or rebuild it. */
  function drawTutorial() {
    const { state, step } = tutorial;
    $('settings-tutorial-status').textContent = {
      new: 'You have not taken the tutorial yet. It takes about 20 minutes. You need no hardware.',
      skipped: 'You skipped the tutorial. You can take it any time.',
      started: `In progress: step ${step} of 18.`,
      done: 'You finished the tutorial.',
    }[state] ?? '';
    $('settings-tutorial-resume').hidden = state !== 'started';
    $('settings-tutorial-resume').textContent = `Resume the tutorial (step ${step} of 18)`;
    $('settings-tutorial-start').textContent = state === 'started' || state === 'done' ? 'Start the tutorial again' : 'Start the tutorial';
    $('settings-tutorial-confirm').hidden = true;
  }
  async function beginTutorial(options) {
    $('settings-tutorial-confirm').hidden = true;
    close();
    await handlers.startTutorial?.(options);
  }
  $('settings-tutorial-resume').addEventListener('click', () => beginTutorial({ resume: true }));
  $('settings-tutorial-start').addEventListener('click', () => {
    // Starting again clears the practice board, so a tutorial with progress asks first.
    if (tutorial.state === 'started' || tutorial.state === 'done') {
      $('settings-tutorial-confirm').hidden = false;
      $('settings-tutorial-confirm-no').focus();
    } else beginTutorial({ restart: true });
  });
  $('settings-tutorial-confirm-yes').addEventListener('click', () => beginTutorial({ restart: true }));
  $('settings-tutorial-confirm-no').addEventListener('click', () => {
    $('settings-tutorial-confirm').hidden = true;
    $('settings-tutorial-start').focus();
  });
  $('settings-welcome').addEventListener('click', async () => {
    const note = $('settings-welcome-note');
    note.textContent = '';
    try {
      await handlers.showWelcome();
      close();
    } catch (error) { note.textContent = error.message; }
  });

  $('settings-open').addEventListener('click', () => open());
  $('settings-close').addEventListener('click', close);
  // A dialog that is not modal (no showModal) has no native Escape or focus trap; Escape still closes it.
  dialog.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !modal) { event.preventDefault(); close(); } });
  dialog.addEventListener('close', () => { $('settings-open').focus(); });

  /** A switch that saves a setting; when the service refuses, it goes back and says why. */
  async function toggle(box, key, message) {
    const wanted = box.checked;
    box.disabled = true;
    message('');
    try { await handlers.onSetSetting?.({ [key]: wanted ? 'on' : 'off' }); }
    catch (error) { box.checked = !wanted; message(error.message); }
    finally { box.disabled = false; }
    if (key === 'git') refreshGit();
  }
  $('settings-assistant').addEventListener('change', (event) => toggle(event.target, 'assistant', (text) => { $('settings-message').textContent = text; }));
  $('settings-git').addEventListener('change', (event) => toggle(event.target, 'git', (text) => { $('settings-message').textContent = text; }));

  function result(step, text, ok) {
    const node = $(`git-result-${step}`);
    node.textContent = text;
    node.dataset.ok = ok === undefined ? '' : String(ok);
  }

  function setBusy(value) {
    busy = value;
    for (const step of STEPS) $(`git-step-${step}`).disabled = value;
  }

  async function runStep(step, extra = {}) {
    if (busy) return;
    setBusy(true);
    $('git-replace').hidden = true;
    result(step, WAITING[step] ?? 'Wait for the result.');
    try {
      const answer = await handlers.gitSetup({ step, ...extra });
      result(step, answer.detail, answer.ok);
      if (step === 'remote' && !answer.ok && answer.confirm) {
        pendingReplace = answer.confirm;
        result(step, `The remote address is already ${answer.confirm.old}. Replace it with ${answer.confirm.new}?`);
        $('git-replace').hidden = false;
        $('git-replace-yes').focus();
      }
    } catch (error) { result(step, error.message, false); }
    finally { setBusy(false); }
    refreshGit();
  }
  for (const step of STEPS) {
    $(`git-step-${step}`).addEventListener('click', () => {
      if (step === 'remote') runStep('remote', { url: $('git-remote-url').value.trim() });
      else runStep(step);
    });
  }
  $('git-replace-yes').addEventListener('click', () => {
    const confirm = pendingReplace;
    pendingReplace = null;
    // The address the person was asked about, even if the field was edited since.
    if (confirm) runStep('remote', { url: confirm.new, replace: true });
  });
  $('git-replace-no').addEventListener('click', () => {
    pendingReplace = null;
    $('git-replace').hidden = true;
    result('remote', 'The existing remote address was kept.', true);
  });

  function drawStatus(detail) {
    const rows = [
      ['Folder', detail.folder],
      ['git', detail.git ? 'installed' : 'missing'],
      ['gitleaks', detail.gitleaks ? 'installed' : 'missing'],
      ['Repository', detail.repository ? 'yes' : 'not yet'],
      ['Commit guard', detail.guard ? 'active' : 'not active'],
      ['Photo originals', detail.originals_ignored === null ? 'not checked yet' : detail.originals_ignored ? 'ignored' : 'NOT ignored'],
      ['Remote', detail.remote ?? 'none. Commits stay on this computer.'],
      ['Last commit', detail.last_commit ?? 'none yet'],
    ];
    $('git-status').replaceChildren(...rows.flatMap(([name, value]) => [el('dt', '', name), el('dd', '', String(value))]));
    $('git-push-note').textContent = detail.remote ? ', then push' : ', no remote set so nothing is pushed';
  }

  async function refreshGit() {
    const started = ++generation;
    let answer;
    try { answer = await handlers.gitStatus(); }
    catch (error) {
      if (started !== generation) return;
      $('git-status').replaceChildren();
      $('git-message').textContent = `Could not read the git status: ${error.message}`;
      return;
    }
    if (started !== generation) return;
    drawStatus(answer.detail);
    const { problems, setting } = answer.detail;
    $('git-message').textContent = setting === 'on' && problems.length ? `Git is on but needs attention: ${problems.join('; ')}` : '';
  }

  return {
    open,
    close,
    isOpen: () => dialog.open,
    setTutorial(info) {
      tutorial = { state: info.state ?? 'new', step: info.step ?? 1 };
      drawTutorial();
    },
    setAssistant(value) { $('settings-assistant').checked = value === 'on'; },
    setGit(value) {
      $('settings-git').checked = value === 'on';
      if (dialog.open) refreshGit();
    },
  };
}
