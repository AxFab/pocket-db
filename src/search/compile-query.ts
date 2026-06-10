import type {
  AndPredicate,
  CompiledQuery,
  FieldOperator,
  FieldOperatorMap,
  FieldQuery,
  NorPredicate,
  OrPredicate,
  Query
} from "./types.js";

const SUPPORTED_FIELD_OPERATORS = new Set([
  "$eq", "$ne",
  "$gt", "$gte",
  "$lt", "$lte",
  "$in", "$nin",
  "$exists",
  "$regex", "$options",
  "$not"
]);

/**
 * Regex flags accepted by `$regex` / `$options`.
 * `g` and `y` are rejected because they make `RegExp.test` stateful
 * (`lastIndex` carries over between calls), producing unstable matches.
 */
const ALLOWED_REGEX_FLAGS = new Set(["i", "m", "s", "u"]);

export function compileQuery(query: Query): CompiledQuery {
  const predicates: CompiledQuery[] = [];

  for (const [field, condition] of Object.entries(query)) {
    if (field === "$and") {
      for (const p of compileLogical("and", condition).predicates) {
        predicates.push(p);
      }
      continue;
    }

    if (field === "$or") {
      predicates.push(compileLogical("or", condition));
      continue;
    }

    if (field === "$nor") {
      predicates.push(compileLogical("nor", condition));
      continue;
    }

    predicates.push({
      type: "field",
      field,
      operators: compileFieldOperators(condition as FieldQuery)
    });
  }

  return { type: "and", predicates };
}

// ---------------------------------------------------------------------------
// Logical predicates
// ---------------------------------------------------------------------------

function compileLogical(
  type: "and" | "or" | "nor",
  condition: unknown
): AndPredicate | OrPredicate | NorPredicate {
  if (!Array.isArray(condition)) {
    throw new Error(`$${type} must be an array of queries.`);
  }

  return {
    type,
    predicates: condition.map((entry) => compileQuery(entry as Query))
  };
}

// ---------------------------------------------------------------------------
// Field predicates
// ---------------------------------------------------------------------------

export function compileFieldOperators(condition: FieldQuery): FieldOperator[] {
  if (condition instanceof RegExp) {
    return [{ type: "regex", regex: buildRegex(condition, undefined) }];
  }

  if (!isOperatorObject(condition)) {
    return [{ type: "eq", value: condition }];
  }

  const operators: FieldOperator[] = [];

  for (const [operator, value] of Object.entries(condition)) {
    if (!SUPPORTED_FIELD_OPERATORS.has(operator)) {
      throw new Error(`Unsupported query operator: ${operator}.`);
    }

    switch (operator) {
      case "$eq":
        operators.push({ type: "eq", value: value as never });
        break;

      case "$ne":
        operators.push({ type: "ne", value: value as never });
        break;

      case "$gt":
        operators.push({ type: "gt", value: value as never });
        break;

      case "$gte":
        operators.push({ type: "gte", value: value as never });
        break;

      case "$lt":
        operators.push({ type: "lt", value: value as never });
        break;

      case "$lte":
        operators.push({ type: "lte", value: value as never });
        break;

      case "$in":
        if (!Array.isArray(value)) throw new Error("$in must be an array.");
        operators.push({ type: "in", values: value as never });
        break;

      case "$nin":
        if (!Array.isArray(value)) throw new Error("$nin must be an array.");
        operators.push({ type: "nin", values: value as never });
        break;

      case "$exists":
        if (typeof value !== "boolean") throw new Error("$exists must be a boolean.");
        operators.push({ type: "exists", value });
        break;

      case "$regex":
        operators.push({ type: "regex", regex: buildRegex(value, condition.$options) });
        break;

      case "$options":
        // Consumed together with $regex above; standalone usage is invalid.
        if (!Object.hasOwn(condition, "$regex")) {
          throw new Error("$options requires a $regex operator.");
        }
        break;

      case "$not": {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("$not requires an operator expression object.");
        }
        if (Object.keys(value).length === 0) {
          throw new Error("$not requires at least one operator.");
        }
        const inner = compileFieldOperators(value as FieldOperatorMap);
        operators.push({ type: "not", operators: inner });
        break;
      }
    }
  }

  return operators;
}

export function isOperatorObject(condition: FieldQuery): condition is FieldOperatorMap {
  if (!condition || typeof condition !== "object" || Array.isArray(condition) || condition instanceof RegExp) {
    return false;
  }

  return Object.keys(condition).some((key) => key.startsWith("$"));
}

// ---------------------------------------------------------------------------
// $regex helpers
// ---------------------------------------------------------------------------

/**
 * Builds the `RegExp` used by a `$regex` operator.
 *
 * - Pattern string + optional `$options` flags string.
 * - `RegExp` instance with its own flags (mutually exclusive with `$options`).
 *
 * Flags are restricted to {@link ALLOWED_REGEX_FLAGS}; `g` and `y` are
 * rejected because `RegExp.test` becomes stateful with them.
 */
function buildRegex(pattern: unknown, options: unknown): RegExp {
  if (pattern instanceof RegExp) {
    if (options !== undefined) {
      throw new Error("$options cannot be combined with a RegExp $regex value; set flags on the RegExp instead.");
    }

    assertRegexFlags(pattern.flags);
    return new RegExp(pattern.source, pattern.flags);
  }

  if (typeof pattern !== "string") {
    throw new Error("$regex must be a string or a RegExp.");
  }

  const flags = options === undefined ? "" : options;

  if (typeof flags !== "string") {
    throw new Error("$options must be a string of regex flags.");
  }

  assertRegexFlags(flags);

  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(`Invalid $regex pattern: ${(error as Error).message}`);
  }
}

function assertRegexFlags(flags: string): void {
  for (const flag of flags) {
    if (!ALLOWED_REGEX_FLAGS.has(flag)) {
      throw new Error(`Unsupported $regex flag "${flag}". Allowed flags: i, m, s, u.`);
    }
  }
}
