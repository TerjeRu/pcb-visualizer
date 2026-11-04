// Text from a model can hide characters that do not print: controls, line breaks, zero-width marks and the
// bidirectional overrides that make a command read differently from what it is. Show each as its code point.

const NON_PRINTING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function showInvisible(text) {
  return String(text ?? '').replace(NON_PRINTING, (ch) => {
    const hex = ch.codePointAt(0).toString(16).toUpperCase();
    return hex.length <= 4 ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
  });
}
