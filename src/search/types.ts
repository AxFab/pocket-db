export type DocumentValue =
  | null
  | boolean
  | number
  | string
  | DocumentValue[]
  | { [key: string]: DocumentValue };

export type DocumentRecord = Record<string, DocumentValue | undefined>;

export type QueryValue = DocumentValue | undefined;

/**
 * Operator expression used inside a field condition.
 * `$not` accepts the same operators (except a nested `$not`).
 */
export type FieldOperatorMap = {
  $eq?: QueryValue;
  $ne?: QueryValue;
  $gt?: QueryValue;
  $gte?: QueryValue;
  $lt?: QueryValue;
  $lte?: QueryValue;
  $in?: QueryValue[];
  $nin?: QueryValue[];
  $exists?: boolean;
  /**
   * Matches string field values against a regular expression.
   * Accepts a pattern string (flags via `$options`) or a `RegExp` instance.
   * Allowed flags: `i`, `m`, `s`, `u`. The `g` and `y` flags are rejected
   * because they make `RegExp.test` stateful.
   */
  $regex?: string | RegExp;
  /** Flags for `$regex` when the pattern is given as a string. */
  $options?: string;
  /**
   * Matches field values by their JSON type. Accepts a single type name or an
   * array of type names (matches if the value is any of them). A missing field
   * never matches. See {@link DocumentTypeName} for the accepted names.
   */
  $type?: DocumentTypeName | DocumentTypeName[];
  /** Negates the combined result of the enclosed operator expression. */
  $not?: Omit<FieldOperatorMap, "$not">;
};

/**
 * JSON type names accepted by the `$type` query operator. `"bool"` is an alias
 * for `"boolean"`. `null` is its own type; `"array"` is reported for arrays and
 * `"object"` only for plain objects (never arrays).
 */
export type DocumentTypeName =
  | "null"
  | "boolean"
  | "bool"
  | "number"
  | "string"
  | "array"
  | "object";

/** Canonical type names after `"bool"` has been normalized to `"boolean"`. */
export type CanonicalTypeName = Exclude<DocumentTypeName, "bool">;

/** A bare `RegExp` condition is shorthand for `{ $regex: <regexp> }`. */
export type FieldQuery = QueryValue | RegExp | FieldOperatorMap;

export type Query = {
  $and?: Query[];
  $or?: Query[];
  $nor?: Query[];
} & {
  [field: string]: FieldQuery | Query[] | undefined;
};

export type CompiledQuery = AndPredicate | OrPredicate | NorPredicate | FieldPredicate;

export interface AndPredicate {
  type: "and";
  predicates: CompiledQuery[];
}

export interface OrPredicate {
  type: "or";
  predicates: CompiledQuery[];
}

export interface NorPredicate {
  type: "nor";
  predicates: CompiledQuery[];
}

export interface FieldPredicate {
  type: "field";
  field: string;
  operators: FieldOperator[];
}

export type FieldOperator =
  | { type: "eq";     value: QueryValue }
  | { type: "ne";     value: QueryValue }
  | { type: "gt";     value: QueryValue }
  | { type: "gte";    value: QueryValue }
  | { type: "lt";     value: QueryValue }
  | { type: "lte";    value: QueryValue }
  | { type: "in";     values: QueryValue[] }
  | { type: "nin";    values: QueryValue[] }
  | { type: "exists"; value: boolean }
  | { type: "regex";  regex: RegExp }
  | { type: "type";   types: CanonicalTypeName[] }
  | { type: "not";    operators: FieldOperator[] };

/**
 * Value accepted by `$currentDate` for a field:
 * - `true` or `{ $type: "date" }` → ISO-8601 string (e.g. `"2026-06-10T12:00:00.000Z"`)
 * - `{ $type: "timestamp" }` → Unix epoch milliseconds (number)
 */
export type CurrentDateSpec = true | { $type: "date" | "timestamp" };

/**
 * Condition accepted by `$pull` for a field: either a literal value
 * (elements equal to it are removed) or an operator expression
 * (elements matching it are removed).
 */
export type PullCondition = DocumentValue | FieldOperatorMap;

export type UpdateExpression = {
  $set?: Record<string, DocumentValue>;
  $unset?: Record<string, unknown>;
  $min?: Record<string, number>;
  $max?: Record<string, number>;
  $inc?: Record<string, number>;
  /** Multiplies an existing number field by the given factor. */
  $mul?: Record<string, number>;
  /** Renames a field. Maps current field name → new field name. */
  $rename?: Record<string, string>;
  /** Sets a field to the current date. See {@link CurrentDateSpec} for formats. */
  $currentDate?: Record<string, CurrentDateSpec>;
  $push?: Record<string, DocumentValue>;
  /** Appends a value to an existing array only if no equal element is present. */
  $addToSet?: Record<string, DocumentValue>;
  /** Removes the first (`-1`) or last (`1`) element of an existing array. */
  $pop?: Record<string, 1 | -1>;
  /** Removes all array elements equal to a value or matching a condition. */
  $pull?: Record<string, PullCondition>;
  /** Removes all array elements equal to any of the listed values. */
  $pullAll?: Record<string, DocumentValue[]>;
}  & Record<string, unknown>;
