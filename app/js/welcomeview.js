// The first-start Welcome inside the empty-board panel. It shows while the saved `welcomed` setting is false
// and replaces the plain "No boards yet" text; Skip, or opening any board, ends it for good. Settings can
// also open it at any time without changing that setting; with boards in the list it then offers Back to
// my boards instead of Skip. It makes no request outside the service.

import { dom } from './dom.js';
import { drawChecks } from './benchlist.js';

export function createWelcomeView(doc, handlers) {
  const { $ } = dom(doc);
  let showing = false;
  let saved = false;          // the saved setting asks for the Welcome
  let opened = false;         // Settings opened it
  let generation = 0;         // a check result for an earlier request is dropped

  async function loadChecks() {
    const started = ++generation;
    try {
      const checks = await handlers.benchCheck();
      if (started === generation) drawChecks(doc, $('welcome-checks'), checks);
    } catch (error) {
      if (started === generation) drawChecks(doc, $('welcome-checks'), null, error.message);
    }
  }

  let tutorial = { state: 'new', step: 1 };
  $('welcome-tutorial').addEventListener('click', () => handlers.startTutorial?.({ resume: tutorial.state === 'started' }));
  $('welcome-create').addEventListener('click', () => handlers.onNewBoard());
  $('welcome-start').addEventListener('click', () => handlers.onReadPage?.('start-here', 'welcome-start'));
  $('welcome-needs').addEventListener('click', () => handlers.onReadPage?.('what-you-need', 'welcome-needs'));
  $('welcome-git').addEventListener('click', () => handlers.onOpenSettings?.('git'));
  $('welcome-assistant').addEventListener('click', () => handlers.onOpenSettings?.('assistant'));
  $('welcome-checks-again').addEventListener('click', loadChecks);
  $('welcome-skip').addEventListener('click', async () => {
    try { await handlers.skipWelcome(); }
    catch (error) { handlers.showError?.(error.message); return; }
    opened = false;
    draw();
    handlers.onNewBoard();
  });
  $('welcome-back').addEventListener('click', () => handlers.backFromWelcome?.());

  function drawTutorial() {
    const button = $('welcome-tutorial');
    const started = tutorial.state === 'started';
    button.hidden = tutorial.state === 'done';
    button.textContent = started ? `Resume the tutorial (step ${tutorial.step} of 18)` : 'Start the tutorial';
    button.classList.toggle('primary', tutorial.state !== 'skipped');
    $('welcome-tutorial-note').hidden = tutorial.state === 'done' || started;
  }

  function draw() {
    const wanted = saved || opened;
    if (wanted === showing) return;
    showing = wanted;
    $('welcome').hidden = !wanted;
    $('no-boards').hidden = wanted;
    if (wanted) loadChecks();
  }

  return {
    /** The saved tutorial state: the first button starts it, or resumes it where it stopped. */
    setTutorial({ state, step }) {
      tutorial = { state: state ?? 'new', step: step ?? 1 };
      drawTutorial();
    },
    /** `welcomed` false shows the card; anything else shows the plain empty text. */
    set({ welcomed, dataFolder }) {
      if (dataFolder) $('welcome-folder').textContent = dataFolder;
      saved = welcomed === false;
      draw();
    },
    /** Settings asked for it. `back`: there are boards to go back to, so Back replaces Skip. */
    open({ back }) {
      opened = true;
      $('welcome-back').hidden = !back;
      $('welcome-skip').hidden = back;
      draw();
    },
    /** A board opened. */
    close() {
      opened = false;
      $('welcome-back').hidden = true;
      $('welcome-skip').hidden = false;
      draw();
    },
  };
}
