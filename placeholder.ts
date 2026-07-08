// Shared placeholder-variable check, used by both the selection walk
// (traversal.ts) and the master-component lookup (matching.ts).

import { PLACEHOLDER_VARIABLE_NAMES, PLACEHOLDER_COLLECTION_NAMES } from './config';

export async function isPlaceholder(variableId: string): Promise<boolean> {
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
