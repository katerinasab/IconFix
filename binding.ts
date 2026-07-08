// Applies a chosen token candidate to a broken paint: strips any placeholder
// paint layers and (re)binds the remaining/created paint to the real token.

import type { BrokenPaint, TokenCandidate } from './types';

export async function resolveVariable(candidate: TokenCandidate): Promise<Variable> {
  if (candidate.isLibrary && candidate.libraryKey) {
    return figma.variables.importVariableByKeyAsync(candidate.libraryKey);
  }
  return candidate.variable;
}

/**
 * Applies a chosen token candidate to a broken paint. Returns whether the
 * write actually stuck — Figma can silently reject a fills/strokes
 * reassignment on certain deeply-nested instance children (seen in practice
 * on icon glyphs whose Set/Size component properties are themselves
 * variable-bound), with no thrown error and no visible symptom other than
 * the value being unchanged on read-back. Callers must not treat this as
 * "fixed" unless the returned value is true.
 */
export async function applyFix(broken: BrokenPaint, candidate: TokenCandidate): Promise<boolean> {
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

  const verifyPaints = node[field] as Paint[];
  const boundId = (verifyPaints[lastIndex] as SolidPaint)?.boundVariables?.color?.id;
  return boundId === variable.id;
}
