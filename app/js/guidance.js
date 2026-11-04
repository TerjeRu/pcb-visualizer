// Beginner help is marked with class "guide" and hidden in Expert; an empty state also carries a short
// "terse" form that only Expert shows. Views that set a state from code use this for the pair.

export function setGuided(node, long, short) {
  const part = (className, text) => {
    const span = node.ownerDocument.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
  };
  node.replaceChildren(part('guide', long), part('terse', short));
}
