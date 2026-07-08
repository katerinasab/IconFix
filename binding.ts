// Applies a chosen token candidate to a broken paint: strips any placeholder
// paint layers and (re)binds the remaining/created paint to the real token.

import type { BrokenPaint, TokenCandidate } from './types';

export async function resolveVariable(candidate: TokenCandidate): Promise<Variable> {
  if (candidate.isLibrary && candidate.libraryKey) {
    return figma.variables.importVariableByKeyAsync(candidate.libraryKey);
  }
  return candidate.variable;
}

export async function applyFix(broken: BrokenPaint, candidate: TokenCandidate): Promise<void> {
  const variable = await resolveVariable(candidate);
  const { node, field, placeholderIndices } = broken;

  const existing = (node[field] as Paint[]).slice();
  const kept = existing.filter((_, i) => !placeholderIndices.includes(i));
  const paints: Paint[] =
    kept.length > 0 ? kept : [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];

  const lastIndex = paints.length - 1;
  paints[lastIndex] = figma.variables.setBoundVariableForPaint(
    paints[lastIndex] as SolidPaint,
    'color',
    variable,
  );

  node[field] = paints;
}
