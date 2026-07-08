// Shared types for the icon token repair plugin.

export type PaintField = 'fills' | 'strokes';

export type Classification = 'OK' | 'TOTAL_LOSS' | 'STRAY_PLACEHOLDER';

export interface BrokenPaint {
  node: SceneNode & { fills: Paint[]; strokes: Paint[] };
  field: PaintField;
  classification: Exclude<Classification, 'OK'>;
  /** Indices into node[field] that are bound to a placeholder variable. */
  placeholderIndices: number[];
  /** Indices into node[field] that are bound to a real, resolvable variable. */
  goodIndices: number[];
}

export interface TokenCandidate {
  variable: Variable;
  /** Where the variable lives: a local collection name, or the library name for remote ones. */
  source: string;
  isLibrary: boolean;
  libraryKey?: string;
  score: number;
}

export type ResolutionKind = 'AUTO_BIND' | 'AMBIGUOUS_NONE' | 'AMBIGUOUS_MULTI';

export interface Resolution {
  kind: ResolutionKind;
  candidates: TokenCandidate[];
  /** Present when kind === 'AUTO_BIND'. */
  target?: TokenCandidate;
  component: string;
  state: string;
}

export interface AmbiguousReport {
  nodeId: string;
  nodePath: string;
  field: PaintField;
  component: string;
  state: string;
  reason: ResolutionKind;
  candidateNames: string[];
}

export interface FixedReport {
  nodeId: string;
  nodePath: string;
  field: PaintField;
  boundTo: string;
}

export interface RunResult {
  fixed: FixedReport[];
  ambiguous: AmbiguousReport[];
  /** Correct token found, but Figma silently rejected the write on
   * read-back — happens on some deeply-nested instance children whose
   * component properties are themselves variable-bound. Needs a manual fix
   * via the Fill panel; scripting cannot apply it. */
  applyFailed: FixedReport[];
  skippedOkCount: number;
}
