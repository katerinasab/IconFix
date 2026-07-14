// Walks the current selection (descending into instance children) and
// classifies every fills/strokes paint as OK, a total loss of binding, or a
// stray placeholder paint sitting alongside a still-good one.

import { HARDCODED_PLACEHOLDER_COLORS } from './config';
import { isPlaceholder } from './placeholder';
import type { BrokenPaint, PaintField } from './types';

const PAINT_FIELDS: PaintField[] = ['fills', 'strokes'];

function hasPaintField(node: SceneNode, field: PaintField): node is SceneNode & {
  fills: Paint[];
  strokes: Paint[];
} {
  const value = (node as unknown as Record<string, unknown>)[field];
  return Array.isArray(value);
}

/** A fully unbound solid paint matching one of the known hardcoded reset
 * colors (see config.ts) — the other symptom of the same Figma bug, where
 * the binding is dropped entirely instead of falling back to a placeholder
 * variable. */
function isHardcodedPlaceholderPaint(paint: Paint): boolean {
  if (paint.type !== 'SOLID') return false;
  return HARDCODED_PLACEHOLDER_COLORS.some(
    (c) => paint.color.r === c.r && paint.color.g === c.g && paint.color.b === c.b,
  );
}

async function classifyField(node: SceneNode, field: PaintField): Promise<BrokenPaint | null> {
  if (!hasPaintField(node, field)) return null;

  const paints = node[field];
  if (paints.length === 0) return null;

  const boundVariables = node.boundVariables as
    | Partial<Record<PaintField, VariableAlias[]>>
    | undefined;
  const boundEntries = boundVariables?.[field];

  const placeholderIndices: number[] = [];
  const goodIndices: number[] = [];

  for (let i = 0; i < paints.length; i++) {
    const entry = boundEntries?.[i];
    if (entry) {
      if (await isPlaceholder(entry.id)) {
        placeholderIndices.push(i);
      } else {
        const variable = await figma.variables.getVariableByIdAsync(entry.id);
        if (variable) goodIndices.push(i);
      }
      continue;
    }
    if (isHardcodedPlaceholderPaint(paints[i])) {
      placeholderIndices.push(i);
    }
  }

  if (placeholderIndices.length === 0) return null;

  return {
    node: node as never,
    field,
    classification: goodIndices.length >= 1 ? 'STRAY_PLACEHOLDER' : 'TOTAL_LOSS',
    placeholderIndices,
    goodIndices,
  };
}

async function walk(node: SceneNode, out: BrokenPaint[]): Promise<void> {
  for (const field of PAINT_FIELDS) {
    const result = await classifyField(node, field);
    if (result) out.push(result);
  }
  if ('children' in node && node.children) {
    for (const child of node.children) {
      await walk(child as SceneNode, out);
    }
  }
}

export async function findBrokenPaints(selection: readonly SceneNode[]): Promise<BrokenPaint[]> {
  const out: BrokenPaint[] = [];
  for (const node of selection) {
    await walk(node, out);
  }
  return out;
}
