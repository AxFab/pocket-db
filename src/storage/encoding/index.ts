import { amf3Encoder } from "./amf3-encoder.js";
import { bsonEncoder } from "./bson-encoder.js";
import { cborDocumentEncoder } from "./cbor-encoder.js";
import type { DocumentEncoder } from "./document-encoder.js";
import { jsonEncoder } from "./json-encoder.js";
import { msgpackDocumentEncoder } from "./msgpack-encoder.js";

export type { DocumentEncoder } from "./document-encoder.js";
export { JsonDocumentEncoder, jsonEncoder } from "./json-encoder.js";
export { BsonDocumentEncoder, bsonEncoder } from "./bson-encoder.js";
export { Amf3DocumentEncoder, amf3Encoder } from "./amf3-encoder.js";
export { CborDocumentEncoder, cborDocumentEncoder } from "./cbor-encoder.js";
export { MsgpackDocumentEncoder, msgpackDocumentEncoder } from "./msgpack-encoder.js";

/** ASCII char code for JSON serialization format (`'j'`). */
export const SERIALIZATION_FORMAT_JSON = "j".charCodeAt(0);

/** ASCII char code for BSON serialization format (`'b'`). */
export const SERIALIZATION_FORMAT_BSON = "b".charCodeAt(0);

/** ASCII char code for AMF3 serialization format (`'a'`). */
export const SERIALIZATION_FORMAT_AMF3 = "a".charCodeAt(0);

/** ASCII char code for CBOR serialization format (`'c'`). */
export const SERIALIZATION_FORMAT_CBOR = "c".charCodeAt(0);

/** ASCII char code for MessagePack serialization format (`'m'`). */
export const SERIALIZATION_FORMAT_MSGPACK = "m".charCodeAt(0);

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
    case SERIALIZATION_FORMAT_CBOR:
      return cborDocumentEncoder;
    case SERIALIZATION_FORMAT_MSGPACK:
      return msgpackDocumentEncoder;
    default:
      throw new Error(
        `Unsupported serialization format: ${String.fromCharCode(formatByte)}.`
      );
  }
}
