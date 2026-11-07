// The Export dialog, opened from the Board panel. The service writes the files and answers with where they went.
// It follows the Settings dialog: modal, focus stays inside, Escape closes it, focus returns to the button.

import { dom } from './dom.js';

export function createExportView(doc, handlers) {
  const { $ } = dom(doc);
  let generation = 0;                // bumped by reset(), so a result for the previous board is dropped
  const dialog = $('export-dialog');
  const modal = typeof dialog.showModal === 'function';
  function open() {
    if (dialog.open) return;
    if (modal) dialog.showModal(); else dialog.setAttribute('open', '');
    dialog.querySelector('input[name="format"]').focus();
  }
  function close() {
    if (!dialog.open) return;
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
    $('export-open').focus();
  }
  $('export-open').addEventListener('click', open);
  $('export-close').addEventListener('click', close);
  dialog.addEventListener('close', () => $('export-open').focus());
  // A dialog that is not modal (no showModal) has no native Escape or focus trap; Escape still closes it.
  dialog.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !modal) { event.preventDefault(); close(); } });

  const formats = () => [...$('export-form').querySelectorAll('input[name="format"]:checked')].map((box) => box.value);

  $('export-redact').addEventListener('change', () => { $('export-warning').hidden = $('export-redact').checked; });

  $('export-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const chosen = formats();
    if (!chosen.length) { $('export-result').textContent = 'Choose at least one format.'; return; }
    $('export-run').disabled = true;
    $('export-result').textContent = 'Export in progress…';
    const started = generation;
    try {
      const result = await handlers.exportBoard(chosen, $('export-redact').checked);
      if (started !== generation) return;
      const replaced = Object.values(result.counts ?? {}).reduce((sum, n) => sum + n, 0);
      const privacy = !result.redacted ? 'The files are not redacted. Keep them private.'
        : replaced ? `Redacted: ${replaced} distinct value${replaced === 1 ? '' : 's'} replaced.`
          : 'Redacted: nothing matched the redaction rules.';
      $('export-result').textContent = `${result.files.length} files in ${result.folder}. ${privacy} `;
      const open = doc.createElement('button');
      open.type = 'button';
      open.textContent = 'Open folder';
      open.addEventListener('click', () => handlers.revealExport?.(result.folder));
      $('export-result').append(open);
      handlers.noteExport?.();
    } catch (error) {
      if (started === generation) $('export-result').textContent = `Could not export: ${error.message}`;
    } finally {
      if (started === generation) $('export-run').disabled = false;
    }
  });

  return {
    reset() {
      generation += 1;
      close();
      $('export-run').disabled = false;
      $('export-result').textContent = '';
    },
  };
}
