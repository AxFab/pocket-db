import { alignTo4Bytes } from "./padding.js";
import { assertCollectionId } from "./collection-operation.js";
import { decodeU29, encodeU29 } from "./u29.js";

export type StoredIndexType = "string" | "number";

export interface CreateIndexOperation {
  collectionId: Buffer;
  field: string;
  type: StoredIndexType;
}

const INDEX_TYPE_BYTES: Record<StoredIndexType, number> = {
  string: 1,
  number: 2
};

const INDEX_TYPES_BY_BYTE = new Map<number, StoredIndexType>([
  [1, "string"],
  [2, "number"]
]);

export function encodeCreateIndexPayload(operation: CreateIndexOperation): Buffer {
  assertCollectionId(operation.collectionId);

  const fieldBytes = Buffer.from(operation.field, "utf8");
  const encodedFieldLength = encodeU29(fieldBytes.byteLength);
  const unalignedLength = operation.collectionId.byteLength + 1 + encodedFieldLength.byteLength + fieldBytes.byteLength;
  const payload = Buffer.alloc(alignTo4Bytes(unalignedLength));

  operation.collectionId.copy(payload, 0);
  payload.writeUInt8(INDEX_TYPE_BYTES[operation.type], operation.collectionId.byteLength);
  encodedFieldLength.copy(payload, operation.collectionId.byteLength + 1);
  fieldBytes.copy(payload, operation.collectionId.byteLength + 1 + encodedFieldLength.byteLength);

  return payload;
}

export interface DropIndexOperation {
  collectionId: Buffer;
  field: string;
}

export function encodeDropIndexPayload(operation: DropIndexOperation): Buffer {
  assertCollectionId(operation.collectionId);

  const fieldBytes = Buffer.from(operation.field, "utf8");
  const encodedFieldLength = encodeU29(fieldBytes.byteLength);
  const unalignedLength = operation.collectionId.byteLength + encodedFieldLength.byteLength + fieldBytes.byteLength;
  const payload = Buffer.alloc(alignTo4Bytes(unalignedLength));

  operation.collectionId.copy(payload, 0);
  encodedFieldLength.copy(payload, operation.collectionId.byteLength);
  fieldBytes.copy(payload, operation.collectionId.byteLength + encodedFieldLength.byteLength);

  return payload;
}

export function decodeDropIndexPayload(payload: Buffer): DropIndexOperation {
  const collectionId = Buffer.from(payload.subarray(0, 4));
  assertCollectionId(collectionId);

  const encodedField = decodeU29(payload, 4);
  const fieldStart = 4 + encodedField.bytesRead;
  const fieldEnd = fieldStart + encodedField.value;

  if (fieldEnd > payload.byteLength) {
    throw new Error("Invalid drop index operation: field exceeds payload length.");
  }

  const padding = payload.subarray(fieldEnd);

  if (!padding.every((byte) => byte === 0)) {
    throw new Error("Invalid drop index operation: non-zero padding.");
  }

  return {
    collectionId,
    field: payload.subarray(fieldStart, fieldEnd).toString("utf8")
  };
}

export function decodeCreateIndexPayload(payload: Buffer): CreateIndexOperation {
  const collectionId = Buffer.from(payload.subarray(0, 4));
  assertCollectionId(collectionId);

  const type = INDEX_TYPES_BY_BYTE.get(payload.readUInt8(4));

  if (!type) {
    throw new Error("Invalid create index operation: unknown index type.");
  }

  const encodedField = decodeU29(payload, 5);
  const fieldStart = 5 + encodedField.bytesRead;
  const fieldEnd = fieldStart + encodedField.value;

  if (fieldEnd > payload.byteLength) {
    throw new Error("Invalid create index operation: field exceeds payload length.");
  }

  const padding = payload.subarray(fieldEnd);

  if (!padding.every((byte) => byte === 0)) {
    throw new Error("Invalid create index operation: non-zero padding.");
  }

  return {
    collectionId,
    type,
    field: payload.subarray(fieldStart, fieldEnd).toString("utf8")
  };
}
