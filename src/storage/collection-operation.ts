import { alignTo4Bytes } from "./padding.js";
import { decodeU29, encodeU29 } from "./u29.js";

export interface CollectionDefinition {
  id: Buffer;
  name: string;
  indexes: string[];
}

export function encodeNewCollectionPayload(collection: CollectionDefinition): Buffer {
  assertCollectionId(collection.id);

  const nameBytes = Buffer.from(collection.name, "utf8");
  const encodedNameLength = encodeU29(nameBytes.byteLength);
  const unalignedLength = collection.id.byteLength + encodedNameLength.byteLength + nameBytes.byteLength;
  const payload = Buffer.alloc(alignTo4Bytes(unalignedLength));

  collection.id.copy(payload, 0);
  encodedNameLength.copy(payload, collection.id.byteLength);
  nameBytes.copy(payload, collection.id.byteLength + encodedNameLength.byteLength);

  return payload;
}

export function decodeNewCollectionPayload(payload: Buffer): CollectionDefinition {
  const id = Buffer.from(payload.subarray(0, 4));
  const encodedName = decodeU29(payload, 4);
  const nameStart = 4 + encodedName.bytesRead;
  const nameEnd = nameStart + encodedName.value;

  if (nameEnd > payload.byteLength) {
    throw new Error("Invalid new collection operation: name exceeds payload length.");
  }

  const padding = payload.subarray(nameEnd);

  if (!padding.every((byte) => byte === 0)) {
    throw new Error("Invalid new collection operation: non-zero padding.");
  }

  return {
    id,
    name: payload.subarray(nameStart, nameEnd).toString("utf8"),
    indexes: []
  };
}

export function encodeDropCollectionPayload(id: Buffer): Buffer {
  assertCollectionId(id);
  return Buffer.from(id);
}

export function decodeDropCollectionPayload(payload: Buffer): Buffer {
  if (payload.byteLength !== 4) {
    throw new Error("Invalid drop collection operation: payload must be 4 bytes.");
  }

  const id = Buffer.from(payload.subarray(0, 4));
  assertCollectionId(id);
  return id;
}

export function assertCollectionId(id: Buffer): void {
  if (id.byteLength !== 4) {
    throw new Error("Collection identifier must be exactly 4 bytes.");
  }
}
