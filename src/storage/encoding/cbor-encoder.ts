import { Encoder, decode } from "cbor-x";
import type { DocumentEncoder } from "./document-encoder.js";

// ---------------------------------------------------------------------------
// Shared cbor-x encoder instance
//
// Options:
//   useRecords: false  — never use cbor-x struct records; encode all objects as
//                        plain CBOR maps so decode() always returns a plain JS
//                        object without a registered schema.
//   mapsAsObjects: true — decode CBOR maps (type 5) back to plain JS objects
//                         rather than Map instances.
// ---------------------------------------------------------------------------

const cborEncoder = new Encoder({ useRecords: false, mapsAsObjects: true });

// ---------------------------------------------------------------------------
// Public encoder
// ---------------------------------------------------------------------------

/**
 * CBOR document encoder (file header byte `'c'`).
 *
 * Uses the `cbor-x` library, which implements RFC 7049 / RFC 8949 (CBOR).
 * Only a plain subset is exercised here (maps, arrays, strings, integers,
 * floats, booleans, null), matching the value types supported by pocket-db.
 *
 * Benefits over JSON:
 *   - Binary-native: integers, booleans, and null have compact encodings.
 *   - No string-escaping overhead.
 *   - CBOR integers cover the full JavaScript safe-integer range natively.
 */
export class CborDocumentEncoder implements DocumentEncoder {
  encode(document: Record<string, unknown>): Buffer {
    return Buffer.from(cborEncoder.encode(document));
  }

  decode(bytes: Buffer): Record<string, unknown> {
    const value = decode(bytes) as unknown;

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("CborDocumentEncoder: top-level value must be an object.");
    }

    return value as Record<string, unknown>;
  }
}

/** Shared singleton — CBOR encoder is stateless, no need to instantiate per-call. */
export const cborDocumentEncoder: DocumentEncoder = new CborDocumentEncoder();
