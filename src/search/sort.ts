export type SortDirection = 1 | -1;

export interface SortField {
  field: string;
  direction: SortDirection;
}

/**
 * Maximum number of sort fields accepted by parseSortSpec.
 * Kept intentionally small for an embedded database.
 */
export const MAX_SORT_FIELDS = 4;

/**
 * Validates and converts a user-supplied sort specification object into
 * the internal SortField array used by compareDocuments.
 *
 * Preserves insertion order — critical for multi-key sort semantics.
 */
export function parseSortSpec(spec: Record<string, SortDirection>): SortField[] {
  const entries = Object.entries(spec);

  if (entries.length === 0) {
    throw new Error("Sort specification must contain at least one field.");
  }

  if (entries.length > MAX_SORT_FIELDS) {
    throw new Error(
      `Sort specification cannot exceed ${MAX_SORT_FIELDS} fields (got ${entries.length}).`
    );
  }

  return entries.map(([field, direction]) => {
    if (field.length === 0) {
      throw new Error("Sort field name cannot be empty.");
    }

    if (direction !== 1 && direction !== -1) {
      throw new Error(
        `Sort direction must be 1 (ascending) or -1 (descending), ` +
        `got ${String(direction)} for field "${field}".`
      );
    }

    return { field, direction };
  });
}

/**
 * Compares two documents according to the ordered list of sort fields.
 *
 * For each field the natural comparison is performed (ascending), then
 * multiplied by the direction (1 or -1). The first field that produces a
 * non-zero result determines the order.
 */
export function compareDocuments(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  fields: SortField[]
): number {
  for (const { field, direction } of fields) {
    const cmp = compareValues(a[field], b[field]);

    if (cmp !== 0) {
      return cmp * direction;
    }
  }

  return 0;
}

/**
 * Compares two primitive document values in natural ascending order.
 *
 * Missing values (null, undefined, NaN) are treated as the minimum possible
 * value — they sort before everything else in ascending order. Combined with
 * the direction multiplier in compareDocuments this means:
 *   - ascending  → missing comes first
 *   - descending → missing comes last
 *
 * Type ordering for cross-type comparisons:
 *   missing < boolean < number < string
 *
 * Throws if either value is an array or a non-null object, as complex-type
 * sorting is not supported in this version.
 */
function compareValues(a: unknown, b: unknown): number {
  const aIsMissing = isMissing(a);
  const bIsMissing = isMissing(b);

  if (aIsMissing && bIsMissing) return 0;
  if (aIsMissing) return -1;
  if (bIsMissing) return 1;

  const aRank = typeRank(a);
  const bRank = typeRank(b);

  if (aRank !== bRank) {
    return aRank - bRank;
  }

  if (typeof a === "boolean" && typeof b === "boolean") {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }

  if (typeof a === "number" && typeof b === "number") {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  return 0;
}

/**
 * Returns true for values that sort as "missing":
 * null, undefined, and NaN (a non-finite number that cannot be compared).
 */
function isMissing(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "number" && isNaN(v)) return true;
  return false;
}

/**
 * Returns a numeric rank for the supported primitive types.
 * Throws for arrays and objects, which are not sortable in this version.
 */
function typeRank(v: unknown): number {
  if (typeof v === "boolean") return 1;
  if (typeof v === "number") return 2;
  if (typeof v === "string") return 3;

  if (Array.isArray(v)) {
    throw new Error("Cannot sort on array values: array sort is not supported.");
  }

  throw new Error("Cannot sort on object values: object sort is not supported.");
}
