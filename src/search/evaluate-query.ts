import { compileQuery } from "./compile-query.js";
import type { CompiledQuery, DocumentRecord, DocumentValue, FieldOperator, Query, QueryValue } from "./types.js";

export function matchesQuery(query: Query, document: DocumentRecord): boolean {
  return evaluateCompiledQuery(compileQuery(query), document);
}

export function evaluateCompiledQuery(query: CompiledQuery, document: DocumentRecord): boolean {
  switch (query.type) {
    case "and":
      return query.predicates.every((p) => evaluateCompiledQuery(p, document));

    case "or":
      return query.predicates.length === 0
        ? false
        : query.predicates.some((p) => evaluateCompiledQuery(p, document));

    case "nor":
      return query.predicates.every((p) => !evaluateCompiledQuery(p, document));

    case "field": {
      const hasField = Object.hasOwn(document, query.field);
      const value = document[query.field];
      return query.operators.every((op) => evaluateFieldOperator(op, value, hasField));
    }
  }
}

export function evaluateFieldOperator(operator: FieldOperator, value: QueryValue, hasField: boolean): boolean {
  switch (operator.type) {
    case "exists":
      return hasField === operator.value;

    case "eq":
      return valuesEqual(value, operator.value);

    case "ne":
      return !valuesEqual(value, operator.value);

    case "gt":
      return compareValues(value, operator.value) > 0;

    case "gte":
      return compareValues(value, operator.value) >= 0;

    case "lt":
      return compareValues(value, operator.value) < 0;

    case "lte":
      return compareValues(value, operator.value) <= 0;

    case "in":
      return operator.values.some((candidate) => valuesEqual(value, candidate));

    case "nin":
      return operator.values.every((candidate) => !valuesEqual(value, candidate));

    case "regex":
      // Only string values can match; the compiled RegExp never carries the
      // g/y flags, so `test` is stateless here.
      return typeof value === "string" && operator.regex.test(value);

    case "not":
      return !operator.operators.every((op) => evaluateFieldOperator(op, value, hasField));
  }
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

function compareValues(left: QueryValue, right: QueryValue): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right);
  }

  return Number.NaN;
}

export function valuesEqual(left: QueryValue, right: QueryValue): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  if (isDocumentObject(left) && isDocumentObject(right)) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  return false;
}

function isDocumentObject(value: QueryValue): value is Record<string, DocumentValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
