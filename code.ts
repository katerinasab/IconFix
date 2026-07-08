// Icon Token Repair — fixes icon fill/stroke bindings that Figma resets to
// the generic "current-color" placeholder (see README.md for the bug this
// targets). Runs headless on the current selection: no UI panel — results go
// to figma.notify + the console, and anything ambiguous gets selected on
// canvas for manual follow-up.

import { findBrokenPaints } from './traversal';
import { resolveTarget } from './matching';
import { applyFix } from './binding';
import type { AmbiguousReport, FixedReport, RunResult } from './types';

function nodePath(node: SceneNode): string {
  const parts: string[] = [node.name];
  let parent: BaseNode | null = node.parent;
  while (parent && parent.type !== 'PAGE' && parent.type !== 'DOCUMENT') {
    parts.unshift(parent.name);
    parent = parent.parent;
  }
  return parts.join(' > ');
}

async function run(): Promise<void> {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.notify('Select one or more shapes/instances first.');
    figma.closePlugin();
    return;
  }

  const broken = await findBrokenPaints(selection);
  const result: RunResult = { fixed: [], ambiguous: [], skippedOkCount: 0 };
  const ambiguousNodes: SceneNode[] = [];

  for (const item of broken) {
    const resolution = await resolveTarget(item);

    if (!resolution || resolution.kind !== 'AUTO_BIND' || !resolution.target) {
      const report: AmbiguousReport = {
        nodeId: item.node.id,
        nodePath: nodePath(item.node),
        field: item.field,
        component: resolution?.component ?? '(unresolved anchor)',
        state: resolution?.state ?? '(unresolved anchor)',
        reason: resolution?.kind ?? 'AMBIGUOUS_NONE',
        candidateNames: resolution?.candidates.map((c) => `${c.variable.name} (${c.source})`) ?? [],
      };
      result.ambiguous.push(report);
      ambiguousNodes.push(item.node);
      continue;
    }

    await applyFix(item, resolution.target);
    const fixed: FixedReport = {
      nodeId: item.node.id,
      nodePath: nodePath(item.node),
      field: item.field,
      boundTo: resolution.target.variable.name,
    };
    result.fixed.push(fixed);
  }

  console.log('[Icon Token Repair] fixed:', result.fixed);
  console.log('[Icon Token Repair] needs review:', result.ambiguous);

  if (ambiguousNodes.length > 0) {
    figma.currentPage.selection = ambiguousNodes;
    figma.viewport.scrollAndZoomIntoView(ambiguousNodes);
  }

  const summary =
    `Icon Token Repair: fixed ${result.fixed.length}, needs review ${result.ambiguous.length}` +
    (ambiguousNodes.length > 0 ? ' — selected on canvas, see console for candidates' : '');
  figma.notify(summary, { timeout: 6000 });

  figma.closePlugin();
}

run();
