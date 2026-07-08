// Given a broken icon paint, finds the anchor "real" component instance,
// derives the expected token name shape from it, and searches local +
// team-library variables for the best-matching replacement token.

import {
  WRAPPER_NAMES,
  STATE_PROPERTY_NAMES,
  DEFAULT_STATE,
  ICON_LAYER_NAMES,
  BOOLEAN_FALSE_SYNONYMS,
  BOOLEAN_TRUE_SYNONYMS,
} from './config';
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

function hasStateProperty(instance: InstanceNode): boolean {
  return Object.keys(instance.componentProperties ?? {}).some((key) =>
    STATE_PROPERTY_NAMES.includes(cleanPropertyKey(key).toLowerCase()),
  );
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

  // Primary signal: the real DS component is the nearest ancestor that
  // exposes a recognized "state" variant property — icon glyphs (Set/Style/
  // Color/Size) and thin wrappers like icon-wrapper (Show Icon) never do.
  for (const instance of candidates) {
    if (hasStateProperty(instance)) return instance;
  }

  // Fallback for components with no state axis: nearest instance whose
  // component/set name isn't a known thin wrapper.
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
      continue;
    }
    const token = slugify(value);
    variantTokens.push(token);
    // DS naming often prefers semantic words ("default"/"checked") over the
    // literal boolean-ish value of a variant property — add both so scoring
    // can match either vocabulary.
    if (token === 'true') variantTokens.push(...BOOLEAN_TRUE_SYNONYMS);
    if (token === 'false') variantTokens.push(...BOOLEAN_FALSE_SYNONYMS);
  }

  return { instance, component, state, variantTokens };
}

function matchesShape(name: string, component: string, state: string): boolean {
  const segments = name.split('/');
  // component / ... / <layer> / <state> — at least 3 segments, and the
  // layer right before state must be a known icon/text color layer, so an
  // icon fill never matches a sibling bg/border token of the same component.
  if (segments.length < 3) return false;
  const layer = segments[segments.length - 2].toLowerCase();
  return (
    segments[0].toLowerCase() === component.toLowerCase() &&
    segments[segments.length - 1].toLowerCase() === state.toLowerCase() &&
    ICON_LAYER_NAMES.includes(layer)
  );
}

function scoreCandidate(name: string, variantTokens: string[]): number {
  // Score only the variant-axis segments: exclude the component (index 0)
  // and the trailing layer/state pair, which matchesShape already pinned.
  const axisSegments = name
    .split('/')
    .slice(1, -2)
    .map((s) => s.toLowerCase());
  let score = 0;
  for (const token of variantTokens) {
    if (axisSegments.includes(token)) score++;
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

/** Collapses same-named local/library duplicates into one, preferring the
 * local variable. On a file that is itself a library's source, every local
 * token also comes back from figma.teamLibrary as a "remote" entry with the
 * identical name — that's the same token, not a genuine second candidate. */
function dedupeByName(candidates: TokenCandidate[]): TokenCandidate[] {
  const byName = new Map<string, TokenCandidate>();
  for (const candidate of candidates) {
    const existing = byName.get(candidate.variable.name);
    if (!existing || (existing.isLibrary && !candidate.isLibrary)) {
      byName.set(candidate.variable.name, candidate);
    }
  }
  return Array.from(byName.values());
}

export async function resolveTarget(broken: BrokenPaint): Promise<Resolution | null> {
  const anchor = await describeAnchor(broken.node);
  if (!anchor) return null;

  const candidates = dedupeByName([
    ...(await collectLocalCandidates(anchor)),
    ...(await collectLibraryCandidates(anchor)),
  ]);

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
