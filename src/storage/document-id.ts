import { randomBytes } from "node:crypto";
import { DOCUMENT_IDENTIFIER_BYTES } from "./constants.js";

const PROCESS_RANDOM = randomBytes(5);
let counter = randomBytes(3).readUIntBE(0, 3);

export function createObjectId(): Buffer {
  const id = Buffer.alloc(DOCUMENT_IDENTIFIER_BYTES);
  const timestamp = Math.floor(Date.now() / 1000);

  id.writeUInt32BE(timestamp, 0);
  PROCESS_RANDOM.copy(id, 4);
  id.writeUIntBE(nextCounter(), 9, 3);

  return id;
}

export function objectIdFromHex(id: string): Buffer {
  assertObjectIdHex(id);
  return Buffer.from(id, "hex");
}

export function assertObjectIdHex(id: string): void {
  if (!/^[0-9a-f]{24}$/u.test(id)) {
    throw new Error("Document _id must be a 24-character lowercase hex string.");
  }
}

function nextCounter(): number {
  counter = (counter + 1) & 0xffffff;
  return counter;
}
