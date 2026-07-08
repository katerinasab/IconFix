// Walks the current selection (descending into instance children) and
// classifies every fills/strokes paint as OK, a total loss of binding, or a
// stray placeholder paint sitting alongside a still-good one.

import { PLACEHOLDER_VARIABLE_NAMES, PLACEHOLDER_COLLECTION_NAMES } from './config';
import type { BrokenPaint, PaintField } from './types';

const PAINT_FIELDS: PaintField[] = ['fills', 'strokes'];

async function isPlaceholder(variableId: string): Promise<boolean> {
  const variable = await figma.variables.getVariableByIdAsync(variableId);
  if (!variable) return false;
  if (PLACEHOLDER_VARIABLE_NAMES.includes(variable.name.toLowerCase())) return true;
  if (variable.remote) {
    const collection = await figma.variables.getVariableCollectionByIdAsync(
      variable.variableCollectionId,
    );
    if (collection && PLACEHOLDER_COLLECTION_NAMES.includes(collection.name)) return true;
  }
  return false;
}

function hasPaintField(node: SceneNode, field: PaintField): node is SceneNode & {
  fills: Paint[];
  strokes: Paint[];
} {
  const value = (node as unknown as Record<string, unknown>)[field];
  return Array.isArray(value);
}

async function classifyField(node: SceneNode, field: PaintField): Promise<BrokenPaint | null> {
  if (!hasPaintField(node, field)) return null;

  const boundVariables = node.boundVariables as
    | Partial<Record<PaintField, VariableAlias[]>>
    | undefined;
  const boundEntries = boundVariables?.[field];
  if (!boundEntries || boundEntries.length === 0) return null;

  const placeholderIndices: number[] = [];
  const goodIndices: number[] = [];

  for (let i = 0; i < boundEntries.length; i++) {
    const entry = boundEntries[i];
    if (!entry) continue;
    if (await isPlaceholder(entry.id)) {
      placeholderIndices.push(i);
    } else {
      const variable = await figma.variables.getVariableByIdAsync(entry.id);
      if (variable) goodIndices.push(i);
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
