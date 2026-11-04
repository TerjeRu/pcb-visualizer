// Small text formatters shared by the playbook checks, the history and the panels. Pure.

const list = (value) => (Array.isArray(value) ? value : []);

/** The value as text, cut to `max` characters with an ellipsis. */
export function shortText(value, max = 80) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A logic capture's sample rate, for example "8 MHz" or "500 kHz". */
export function formatRate(samplerate) {
  return samplerate >= 1e6 ? `${samplerate / 1e6} MHz` : `${(samplerate ?? 0) / 1e3} kHz`;
}

/** What the person calls a header: its marker label, else its name, else a placeholder. */
export function headerName(project, schematicId) {
  const label = list(project?.markers).find((m) => m.schematicId === schematicId && m.label)?.label;
  return label || list(project?.schematics).find((s) => s.id === schematicId)?.name || 'a header';
}

/** What a stored guess is called: with the assistant off nothing says AI, the guess is just unverified. */
export const guessName = (assistant) => (assistant === 'off' ? 'Unverified guess' : 'AI guess');

/** A sentence about an AI guess: what it is, how sure and where it came from. */
export function describeGuess(guess, what) {
  return `${what}: ${guess.confidence} certainty${guess.by ? `, from ${guess.by}` : ''}. ${guess.evidence ?? ''}`.trim();
}
