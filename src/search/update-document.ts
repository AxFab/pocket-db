import { compileFieldOperators, isOperatorObject } from "./compile-query.js";
import { evaluateFieldOperator, valuesEqual } from "./evaluate-query.js";
import type { CurrentDateSpec, DocumentRecord, DocumentValue, PullCondition, UpdateExpression } from "./types.js";

const SUPPORTED_UPDATE_OPERATORS = new Set([
  "$set", "$unset",
  "$min", "$max", "$inc", "$mul",
  "$rename", "$currentDate",
  "$push", "$addToSet", "$pop", "$pull", "$pullAll"
]);

export function updateDocument(document: DocumentRecord, update: UpdateExpression): DocumentRecord {
  assertSupportedUpdate(update);

  const updated: DocumentRecord = { ...document };

  for (const key of Object.keys(update)) {
    if (key.startsWith('$')) {
      switch (key) {
        case '$set': applySet(updated, update.$set!); break;
        case '$unset': applyUnset(updated, update.$unset!); break;
        case '$min': applyMin(updated, update.$min!); break;
        case '$max': applyMax(updated, update.$max!); break;
        case '$inc': applyInc(updated, update.$inc!); break;
        case '$mul': applyMul(updated, update.$mul!); break;
        case '$rename': applyRename(updated, update.$rename!); break;
        case '$currentDate': applyCurrentDate(updated, update.$currentDate!); break;
        case '$push': applyPush(updated, update.$push!); break;
        case '$addToSet': applyAddToSet(updated, update.$addToSet!); break;
        case '$pop': applyPop(updated, update.$pop!); break;
        case '$pull': applyPull(updated, update.$pull!); break;
        case '$pullAll': applyPullAll(updated, update.$pullAll!); break;
        default:
          // Log warning or error !!?
          break;
      }
    }
  }
  return updated;
}

function applySet(document: DocumentRecord, values: Record<string, DocumentValue>): void {
  for (const [field, value] of Object.entries(values)) {
    document[field] = value;
  }
}

function applyUnset(document: DocumentRecord, values: Record<string, unknown>): void {
  for (const field of Object.keys(values)) {
    delete document[field];
  }
}

function applyMin(document: DocumentRecord, values: Record<string, number>): void {
  for (const [field, value] of Object.entries(values)) {
    assertNumberUpdateValue("$min", field, value);
    const current = getExistingNumber(document, field, "$min");

    if (value < current) {
      document[field] = value;
    }
  }
}

function applyMax(document: DocumentRecord, values: Record<string, number>): void {
  for (const [field, value] of Object.entries(values)) {
    assertNumberUpdateValue("$max", field, value);
    const current = getExistingNumber(document, field, "$max");

    if (value > current) {
      document[field] = value;
    }
  }
}

function applyInc(document: DocumentRecord, values: Record<string, number>): void {
  for (const [field, value] of Object.entries(values)) {
    assertNumberUpdateValue("$inc", field, value);
    const current = getExistingNumber(document, field, "$inc");
    document[field] = current + value;
  }
}

/** Multiplies existing number fields by the given factors. */
function applyMul(document: DocumentRecord, values: Record<string, number>): void {
  for (const [field, value] of Object.entries(values)) {
    assertNumberUpdateValue("$mul", field, value);
    const current = getExistingNumber(document, field, "$mul");
    document[field] = current * value;
  }
}

/**
 * Renames fields. A missing source field is a no-op (MongoDB semantics);
 * an existing target field is overwritten.
 */
function applyRename(document: DocumentRecord, values: Record<string, string>): void {
  for (const [field, newName] of Object.entries(values)) {
    if (typeof newName !== "string" || newName.length === 0) {
      throw new Error(`Cannot apply $rename to "${field}": new field name must be a non-empty string.`);
    }

    if (newName === field) {
      throw new Error(`Cannot apply $rename to "${field}": source and target names must differ.`);
    }

    if (!Object.hasOwn(document, field)) {
      continue;
    }

    document[newName] = document[field];
    delete document[field];
  }
}

/**
 * Sets fields to the current date.
 * `true` / `{ $type: "date" }` → ISO-8601 string; `{ $type: "timestamp" }` → epoch milliseconds.
 */
function applyCurrentDate(document: DocumentRecord, values: Record<string, CurrentDateSpec>): void {
  const now = new Date();

  for (const [field, spec] of Object.entries(values)) {
    if (spec === true) {
      document[field] = now.toISOString();
      continue;
    }

    if (spec !== null && typeof spec === "object" && !Array.isArray(spec)) {
      if (spec.$type === "date") {
        document[field] = now.toISOString();
        continue;
      }

      if (spec.$type === "timestamp") {
        document[field] = now.getTime();
        continue;
      }
    }

    throw new Error(`Cannot apply $currentDate to "${field}": value must be true or { $type: "date" | "timestamp" }.`);
  }
}

function applyPush(document: DocumentRecord, values: Record<string, DocumentValue>): void {
  for (const [field, value] of Object.entries(values)) {
    const current = getExistingArray(document, field, "$push");
    document[field] = [...current, value];
  }
}

/** Appends a value to an existing array only when no deep-equal element is already present. */
function applyAddToSet(document: DocumentRecord, values: Record<string, DocumentValue>): void {
  for (const [field, value] of Object.entries(values)) {
    const current = getExistingArray(document, field, "$addToSet");

    if (!current.some((element) => valuesEqual(element, value))) {
      document[field] = [...current, value];
    }
  }
}

/** Removes the first (`-1`) or last (`1`) element of an existing array. Empty arrays are a no-op. */
function applyPop(document: DocumentRecord, values: Record<string, 1 | -1>): void {
  for (const [field, direction] of Object.entries(values)) {
    if (direction !== 1 && direction !== -1) {
      throw new Error(`Cannot apply $pop to "${field}": value must be 1 (last) or -1 (first).`);
    }

    const current = getExistingArray(document, field, "$pop");

    if (current.length === 0) {
      continue;
    }

    document[field] = direction === 1 ? current.slice(0, -1) : current.slice(1);
  }
}

/**
 * Removes every array element equal to the condition value, or — when the
 * condition is an operator expression (e.g. `{ $gt: 5 }`) — every element
 * matching it.
 */
function applyPull(document: DocumentRecord, values: Record<string, PullCondition>): void {
  for (const [field, condition] of Object.entries(values)) {
    const current = getExistingArray(document, field, "$pull");

    if (isOperatorObject(condition)) {
      const operators = compileFieldOperators(condition);
      document[field] = current.filter(
        (element) => !operators.every((operator) => evaluateFieldOperator(operator, element, true))
      );
      continue;
    }

    document[field] = current.filter((element) => !valuesEqual(element, condition));
  }
}

/** Removes every array element equal to any of the listed values. */
function applyPullAll(document: DocumentRecord, values: Record<string, DocumentValue[]>): void {
  for (const [field, candidates] of Object.entries(values)) {
    if (!Array.isArray(candidates)) {
      throw new Error(`Cannot apply $pullAll to "${field}": value must be an array.`);
    }

    const current = getExistingArray(document, field, "$pullAll");
    document[field] = current.filter(
      (element) => !candidates.some((candidate) => valuesEqual(element, candidate))
    );
  }
}

function getExistingArray(document: DocumentRecord, field: string, operator: string): DocumentValue[] {
  const current = document[field];

  if (!Array.isArray(current)) {
    throw new Error(`Cannot apply ${operator} to "${field}": expected an existing array field.`);
  }

  return current;
}

function getExistingNumber(document: DocumentRecord, field: string, operator: string): number {
  const current = document[field];

  if (typeof current !== "number") {
    throw new Error(`Cannot apply ${operator} to "${field}": expected an existing number field.`);
  }

  return current;
}

function assertNumberUpdateValue(operator: string, field: string, value: number): void {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Cannot apply ${operator} to "${field}": update value must be a number.`);
  }
}

function assertSupportedUpdate(update: UpdateExpression): void {
  for (const operator of Object.keys(update)) {
    if (!SUPPORTED_UPDATE_OPERATORS.has(operator)) {
      throw new Error(`Unsupported update operator: ${operator}.`);
    }
  }
}
