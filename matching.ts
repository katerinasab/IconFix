// Given a broken icon paint, finds the anchor "real" component instance,
// derives the expected token name shape from it, and searches local +
// team-library variables for the best-matching replacement token.

import { WRAPPER_NAMES, STATE_PROPERTY_NAMES, DEFAULT_STATE } from './config';
import type { BrokenPaint, Resolution, TokenCandidate } from './types';

interface Anchor {
  instance: InstanceNode;
  component: string;
  state: string;
  variantTokens: string[];
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

function cleanPropertyKey(key: string): string {
  return key.split('#')[0];
}

async function findAnchorInstance(node: SceneNode): Promise<InstanceNode | null> {
  let current: BaseNode | null = node.parent;
  const candidates: InstanceNode[] = [];
  while (current) {
    if (current.type === 'INSTANCE') {
      candidates.push(current);
    }
    current = current.parent;
  }
  for (const instance of candidates) {
    const main = await instance.getMainComponentAsync();
    const name = (main?.parent?.type === 'COMPONENT_SET' ? main.parent.name : main?.name) ?? '';
    if (!WRAPPER_NAMES.includes(name.toLowerCase())) {
      return instance;
    }
  }
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

async function describeAnchor(node: SceneNode): Promise<Anchor | null> {
  const instance = await findAnchorInstance(node);
  if (!instance) return null;

  const main = await instance.getMainComponentAsync();
  const componentSetName =
    main?.parent?.type === 'COMPONENT_SET' ? main.parent.name : main?.name;
  if (!componentSetName) return null;
  const component = slugify(componentSetName.split('/')[0]);

  let state = DEFAULT_STATE;
  const variantTokens: string[] = [];
  for (const [rawKey, prop] of Object.entries(instance.componentProperties ?? {})) {
    if (prop.type !== 'VARIANT') continue;
    const key = cleanPropertyKey(rawKey).toLowerCase();
    const value = String(prop.value);
    if (STATE_PROPERTY_NAMES.includes(key)) {
      state = slugify(value);
    } else {
      variantTokens.push(slugify(value));
    }
  }

  return { instance, component, state, variantTokens };
}

function matchesShape(name: string, component: string, state: string): boolean {
  const segments = name.split('/');
  if (segments.length < 2) return false;
  return (
    segments[0].toLowerCase() === component.toLowerCase() &&
    segments[segments.length - 1].toLowerCase() === state.toLowerCase()
  );
}

function scoreCandidate(name: string, variantTokens: string[]): number {
  const middle = name
    .split('/')
    .slice(1, -1)
    .map((s) => s.toLowerCase());
  let score = 0;
  for (const token of variantTokens) {
    if (middle.includes(token)) score++;
  }
  return score;
}

async function collectLocalCandidates(anchor: Anchor): Promise<TokenCandidate[]> {
  const out: TokenCandidate[] = [];
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  for (const collection of collections) {
    const variables = await Promise.all(
      collection.variableIds.map((id) => figma.variables.getVariableByIdAsync(id)),
    );
    for (const variable of variables) {
      if (!variable) continue;
      if (variable.resolvedType !== 'COLOR') continue;
      if (!matchesShape(variable.name, anchor.component, anchor.state)) continue;
      out.push({
        variable,
        source: collection.name,
        isLibrary: false,
        score: scoreCandidate(variable.name, anchor.variantTokens),
      });
    }
  }
  return out;
}

async function collectLibraryCandidates(anchor: Anchor): Promise<TokenCandidate[]> {
  const out: TokenCandidate[] = [];
  let libraryCollections: LibraryVariableCollection[] = [];
  try {
    libraryCollections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  } catch {
    return out;
  }
  for (const libCollection of libraryCollections) {
    let variables: LibraryVariable[] = [];
    try {
      variables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(
        libCollection.key,
      );
    } catch {
      continue;
    }
    for (const variable of variables) {
      if (variable.resolvedType !== 'COLOR') continue;
      if (!matchesShape(variable.name, anchor.component, anchor.state)) continue;
      out.push({
        // library candidates are imported lazily only if chosen; store a
        // placeholder Variable-shaped record via a cast at bind time.
        variable: variable as unknown as Variable,
        source: libCollection.libraryName ?? libCollection.name,
        isLibrary: true,
        libraryKey: variable.key,
        score: scoreCandidate(variable.name, anchor.variantTokens),
      });
    }
  }
  return out;
}

export async function resolveTarget(broken: BrokenPaint): Promise<Resolution | null> {
  const anchor = await describeAnchor(broken.node);
  if (!anchor) return null;

  const candidates = [
    ...(await collectLocalCandidates(anchor)),
    ...(await collectLibraryCandidates(anchor)),
  ];

  if (candidates.length === 0) {
    return { kind: 'AMBIGUOUS_NONE', candidates, component: anchor.component, state: anchor.state };
  }

  const maxScore = Math.max(...candidates.map((c) => c.score));
  const topCandidates = candidates.filter((c) => c.score === maxScore);

  if (topCandidates.length === 1) {
    return {
      kind: 'AUTO_BIND',
      candidates,
      target: topCandidates[0],
      component: anchor.component,
      state: anchor.state,
    };
  }

  return {
    kind: 'AMBIGUOUS_MULTI',
    candidates: topCandidates,
    component: anchor.component,
    state: anchor.state,
  };
}
