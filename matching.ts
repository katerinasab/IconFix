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
import { isPlaceholder } from './placeholder';
import type { BrokenPaint, PaintField, Resolution, TokenCandidate } from './types';

interface Anchor {
  instance: InstanceNode;
  /** The anchor's own main component — instances mirror its structure 1:1
   * by node name at every depth, so it doubles as a ground-truth lookup: the
   * master is rarely hit by the same instance-level reset this plugin fixes. */
  main: ComponentNode;
  component: string;
  state: string;
  variantTokens: string[];
  /** Tokens that mark the *opposite* branch of a boolean-ish variant
   * property (e.g. "checked" when Checked=False) — a candidate containing
   * one of these is scoped to a state this icon isn't in, not just an
   * unrelated word, so it must be excluded rather than merely under-scored. */
  negativeTokens: string[];
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

function booleanSynonyms(token: string): string[] {
  if (token === 'true') return BOOLEAN_TRUE_SYNONYMS;
  if (token === 'false') return BOOLEAN_FALSE_SYNONYMS;
  return [];
}

async function describeAnchor(node: SceneNode): Promise<Anchor | null> {
  const instance = await findAnchorInstance(node);
  if (!instance) return null;

  const main = await instance.getMainComponentAsync();
  if (!main) return null;
  const componentSet = main.parent?.type === 'COMPONENT_SET' ? main.parent : null;
  const componentSetName = componentSet?.name ?? main?.name;
  if (!componentSetName) return null;
  const component = slugify(componentSetName.split('/')[0]);

  // All other options for each variant property, so e.g. an Accent-styled
  // icon can exclude a Subtle-styled token — fetched once per anchor since
  // it requires the component set (variantOptions isn't on the instance).
  const propertyDefs = componentSet?.componentPropertyDefinitions ?? {};

  let state = DEFAULT_STATE;
  const variantTokens: string[] = [];
  const rawNegativeTokens: string[] = [];
  for (const [rawKey, prop] of Object.entries(instance.componentProperties ?? {})) {
    if (prop.type !== 'VARIANT') continue;
    const key = cleanPropertyKey(rawKey).toLowerCase();
    const value = String(prop.value);
    if (STATE_PROPERTY_NAMES.includes(key)) {
      state = slugify(value);
      continue;
    }
    const token = slugify(value);
    // DS naming often prefers semantic words ("default"/"checked") over the
    // literal boolean-ish value of a variant property — add both so scoring
    // can match either vocabulary.
    variantTokens.push(token, ...booleanSynonyms(token));

    // Every other value this property could have taken is scoped to a
    // variant this icon isn't in — e.g. Style=Accent excludes any candidate
    // segment naming the Subtle branch, not just an unrelated word.
    const def = propertyDefs[rawKey];
    const otherValues = def?.type === 'VARIANT' ? (def.variantOptions ?? []) : [];
    for (const other of otherValues) {
      if (other === value) continue;
      const otherToken = slugify(other);
      rawNegativeTokens.push(otherToken, ...booleanSynonyms(otherToken));
    }
  }

  // A word that's both a confirmed positive (the anchor's own real value,
  // possibly via a different property's boolean synonym) and a "some other
  // option" negative is ambiguous vocabulary overloaded across properties
  // (e.g. "default" can mean both Checked=False and Type's other value) —
  // the direct positive evidence from the anchor's actual state wins.
  const negativeTokens = rawNegativeTokens.filter((t) => !variantTokens.includes(t));

  return { instance, main, component, state, variantTokens, negativeTokens };
}

/** The path of node names from the anchor instance down to the broken node —
 * instances mirror their main component's tree by name at every depth, so
 * replaying this same path from the master finds the corresponding node. */
function relativeNamePath(node: SceneNode, ancestor: InstanceNode): string[] {
  const names: string[] = [];
  let current: BaseNode | null = node;
  while (current && current.id !== ancestor.id) {
    names.unshift(current.name);
    current = current.parent;
  }
  return names;
}

/** Replays a name path from the master downward. A name can legitimately
 * differ from the instance at an instance-swapped slot — e.g. an
 * `icon-wrapper`'s nested glyph is "dots_horizontal" on the master but
 * "chevron_left" on this particular instance, since each consumer swaps in
 * its own icon. When the name doesn't match, but the current node has
 * exactly one child, that child is an unambiguous single slot — descend into
 * it anyway rather than failing the whole lookup over a swapped name. */
function findByNamePath(root: BaseNode, path: string[]): BaseNode | null {
  let current: BaseNode | null = root;
  for (const name of path) {
    if (!current || !('children' in current) || !current.children) return null;
    const children = current.children as readonly SceneNode[];
    const byName: SceneNode | undefined = children.find((c) => c.name === name);
    if (byName) {
      current = byName;
    } else if (children.length === 1) {
      current = children[0];
    } else {
      return null;
    }
  }
  return current;
}

/** Copies whatever the anchor's own master component has bound for this
 * exact field — the master is the design system's source of truth, and the
 * "current-color" reset this plugin targets hits instance-level overrides,
 * not the master itself. Far more reliable than guessing from naming when
 * it's available; returns null (not a guess) if the master's own binding is
 * missing, unresolvable, or itself a placeholder. */
async function findMasterMatch(
  anchor: Anchor,
  broken: BrokenPaint,
): Promise<TokenCandidate | null> {
  const path = relativeNamePath(broken.node, anchor.instance);
  const masterNode = findByNamePath(anchor.main, path) as SceneNode | null;
  if (!masterNode) return null;

  const boundEntries = (
    masterNode.boundVariables as Partial<Record<PaintField, VariableAlias[]>> | undefined
  )?.[broken.field];
  if (!boundEntries) return null;

  for (const entry of boundEntries) {
    if (!entry) continue;
    if (await isPlaceholder(entry.id)) continue;
    const variable = await figma.variables.getVariableByIdAsync(entry.id);
    if (!variable) continue;
    return {
      variable,
      source: variable.remote ? 'master component (library)' : 'master component',
      isLibrary: variable.remote,
      libraryKey: variable.remote ? variable.key : undefined,
      score: Number.POSITIVE_INFINITY,
    };
  }
  return null;
}

function hasExcludedSegment(name: string, negativeTokens: string[]): boolean {
  const axisSegments = name
    .split('/')
    .slice(1, -2)
    .map((s) => s.toLowerCase());
  return negativeTokens.some((token) => axisSegments.includes(token));
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

async function collectLocalCandidates(anchor: Anchor, state: string): Promise<TokenCandidate[]> {
  const out: TokenCandidate[] = [];
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  for (const collection of collections) {
    const variables = await Promise.all(
      collection.variableIds.map((id) => figma.variables.getVariableByIdAsync(id)),
    );
    for (const variable of variables) {
      if (!variable) continue;
      if (variable.resolvedType !== 'COLOR') continue;
      if (!matchesShape(variable.name, anchor.component, state)) continue;
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

async function collectLibraryCandidates(anchor: Anchor, state: string): Promise<TokenCandidate[]> {
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
      if (!matchesShape(variable.name, anchor.component, state)) continue;
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

async function searchCandidates(anchor: Anchor, state: string): Promise<TokenCandidate[]> {
  return dedupeByName([
    ...(await collectLocalCandidates(anchor, state)),
    ...(await collectLibraryCandidates(anchor, state)),
  ]);
}

/** Picks the single winning candidate, or null if the field is genuinely
 * ambiguous (none found, or nothing beats a zero score, or a real tie).
 *
 * Tie-break order matters: negative-token exclusion runs LAST, only among
 * candidates already tied on score, never as an upfront filter. A property's
 * "other value" can be a pure naming artifact unrelated to that property at
 * all (e.g. a component's content-color tokens all carry a fixed "default"
 * segment that has nothing to do with its Type axis) — filtering candidates
 * out by that word before scoring can discard the one real match entirely,
 * leaving only a same-shaped but wrong token (often from a different
 * library source) looking like the sole survivor. Positive scoring is the
 * reliable signal; negative tokens only break a genuine tie between
 * equally-scored candidates. */
function pickBest(candidates: TokenCandidate[], negativeTokens: string[]): TokenCandidate | null {
  if (candidates.length === 0) return null;

  const maxScore = Math.max(...candidates.map((c) => c.score));

  // A zero score means nothing about the candidate's variant-axis segments
  // actually matched the anchor — it only shares the component/layer/state
  // shape. Being the sole such match is not evidence of correctness (e.g. a
  // stale/orphaned token elsewhere can silently vanish from the real search,
  // leaving one unrelated same-shaped token looking "unique"); don't guess.
  if (maxScore === 0) return null;

  let topCandidates = candidates.filter((c) => c.score === maxScore);

  // Tie-break 1: prefer local over library among equally-scored candidates —
  // editing this file makes its own local tokens authoritative, and a
  // same-scoring library candidate is often a differently-shaped legacy/
  // mirrored name rather than a genuinely distinct real option.
  if (topCandidates.length > 1) {
    const localTop = topCandidates.filter((c) => !c.isLibrary);
    if (localTop.length > 0) {
      topCandidates = localTop;
    }
  }

  // Tie-break 2: among what's still tied, drop any candidate scoped to a
  // confirmed-opposite variant (e.g. Style=Accent excludes a Subtle-branch
  // token) — but only if that leaves at least one candidate standing.
  if (topCandidates.length > 1) {
    const nonExcluded = topCandidates.filter(
      (c) => !hasExcludedSegment(c.variable.name, negativeTokens),
    );
    if (nonExcluded.length > 0) {
      topCandidates = nonExcluded;
    }
  }

  return topCandidates.length === 1 ? topCandidates[0] : null;
}

export async function resolveTarget(broken: BrokenPaint): Promise<Resolution | null> {
  const anchor = await describeAnchor(broken.node);
  if (!anchor) return null;

  const masterMatch = await findMasterMatch(anchor, broken);
  if (masterMatch) {
    return {
      kind: 'AUTO_BIND',
      candidates: [masterMatch],
      target: masterMatch,
      component: anchor.component,
      state: anchor.state,
      viaMasterLookup: true,
    };
  }

  const candidates = await searchCandidates(anchor, anchor.state);
  const best = pickBest(candidates, anchor.negativeTokens);

  if (best) {
    return {
      kind: 'AUTO_BIND',
      candidates,
      target: best,
      component: anchor.component,
      state: anchor.state,
    };
  }

  // Nothing usable for the icon's actual state. Many design systems only
  // vary content (icon/text) color for a few meaningful states (typically
  // disabled, sometimes checked) while transient interaction states like
  // hover/active only change background/border — so "rest" is a reasonable,
  // low-risk fallback shape, tried only when the real state came up empty.
  if (anchor.state !== DEFAULT_STATE) {
    const fallbackCandidates = await searchCandidates(anchor, DEFAULT_STATE);
    const fallbackBest = pickBest(fallbackCandidates, anchor.negativeTokens);
    if (fallbackBest) {
      return {
        kind: 'AUTO_BIND',
        candidates: fallbackCandidates,
        target: fallbackBest,
        component: anchor.component,
        state: DEFAULT_STATE,
        viaStateFallback: true,
      };
    }
  }

  return {
    kind: candidates.length === 0 ? 'AMBIGUOUS_NONE' : 'AMBIGUOUS_MULTI',
    candidates,
    component: anchor.component,
    state: anchor.state,
  };
}
