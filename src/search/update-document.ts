import type { DocumentRecord, DocumentValue, UpdateExpression } from "./types.js";

const SUPPORTED_UPDATE_OPERATORS = new Set(["$set", "$unset", "$min", "$max", "$inc", "$push"]);

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
        case '$push': applyPush(updated, update.$push!); break;
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

function applyPush(document: DocumentRecord, values: Record<string, DocumentValue>): void {
  for (const [field, value] of Object.entries(values)) {
    const current = document[field];

    if (!Array.isArray(current)) {
      throw new Error(`Cannot apply $push to "${field}": expected an existing array field.`);
    }

    document[field] = [...current, value];
  }
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
