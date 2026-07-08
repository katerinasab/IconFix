// Tunable constants for the icon token repair heuristics. Kept separate from
// the algorithm so new placeholder signatures / wrapper names / state
// properties can be added without touching matching/traversal logic.

/** Variable names that are known stand-ins for "no real token bound". */
export const PLACEHOLDER_VARIABLE_NAMES = ['current-color'];

/** Remote collection names known to host placeholder/default variables. */
export const PLACEHOLDER_COLLECTION_NAMES = ['defaultColors'];

/** Instance names to skip when walking up from a broken icon to find the
 * "real" consuming component (thin slot wrappers, not components themselves). */
export const WRAPPER_NAMES = ['icon-wrapper'];

/** Component-property names (case-insensitive) treated as the "state" axis. */
export const STATE_PROPERTY_NAMES = ['state'];

/** Fallback state segment when no state property is found on the anchor. */
export const DEFAULT_STATE = 'rest';

/** Preferred local collection to search first. */
export const PRIMARY_COLLECTION_NAME = 'Theme';
