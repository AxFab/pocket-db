import { amf3Encoder } from "./amf3-encoder.js";
import { bsonEncoder } from "./bson-encoder.js";
import type { DocumentEncoder } from "./document-encoder.js";
import { jsonEncoder } from "./json-encoder.js";

export type { DocumentEncoder } from "./document-encoder.js";
export { JsonDocumentEncoder, jsonEncoder } from "./json-encoder.js";
export { BsonDocumentEncoder, bsonEncoder } from "./bson-encoder.js";
export { Amf3DocumentEncoder, amf3Encoder } from "./amf3-encoder.js";

/** ASCII char code for JSON serialization format (`'j'`). */
export const SERIALIZATION_FORMAT_JSON = "j".charCodeAt(0);

/** ASCII char code for BSON serialization format (`'b'`). */
export const SERIALIZATION_FORMAT_BSON = "b".charCodeAt(0);

/** ASCII char code for AMF3 serialization format (`'a'`). */
export const SERIALIZATION_FORMAT_AMF3 = "a".charCodeAt(0);

/**
 * Returns the appropriate {@link DocumentEncoder} for the serialization format
 * byte stored in the file header.
 *
 * @param formatByte - The raw byte value read from position 10 of the file header.
 * @throws If the format byte does not correspond to a known encoder.
 */
export function getEncoder(formatByte: number): DocumentEncoder {
  switch (formatByte) {
    case SERIALIZATION_FORMAT_JSON:
      return jsonEncoder;
    case SERIALIZATION_FORMAT_BSON:
      return bsonEncoder;
    case SERIALIZATION_FORMAT_AMF3:
      return amf3Encoder;
    default:
      throw new Error(
        `Unsupported serialization format: ${String.fromCharCode(formatByte)}.`
      );
  }
}
