// The Export section of the Board panel. The service writes the files and answers with where they went.

import { dom } from './dom.js';

export function createExportView(doc, handlers) {
  const { $ } = dom(doc);
  let generation = 0;                // bumped by reset(), so a result for the previous board is dropped
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
      $('export-result').textContent = `${result.files.length} files in ${result.folder}. ${privacy}`;
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
      $('export-run').disabled = false;
      $('export-result').textContent = '';
    },
  };
}
