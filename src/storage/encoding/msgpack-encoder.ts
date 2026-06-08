import { Packr } from "msgpackr";
import type { DocumentEncoder } from "./document-encoder.js";

// ---------------------------------------------------------------------------
// Shared msgpackr packer instance
//
// Options:
//   useRecords: false — never use msgpackr struct records; encode all objects as
//                       plain MessagePack maps so unpack() always returns a plain
//                       JS object without a registered schema.
// ---------------------------------------------------------------------------

const packr = new Packr({ useRecords: false });

// ---------------------------------------------------------------------------
// Public encoder
// ---------------------------------------------------------------------------

/**
 * MessagePack document encoder (file header byte `'m'`).
 *
 * Uses the `msgpackr` library, which implements the MessagePack specification.
 * Only a plain subset is exercised here (maps, arrays, strings, integers,
 * floats, booleans, null), matching the value types supported by pocket-db.
 *
 * Benefits over JSON:
 *   - Binary-native: integers, booleans, and null have compact encodings.
 *   - No string-escaping overhead.
 *   - MessagePack integers cover the full JavaScript safe-integer range natively.
 */
export class MsgpackDocumentEncoder implements DocumentEncoder {
  encode(document: Record<string, unknown>): Buffer {
    return Buffer.from(packr.pack(document));
  }

  decode(bytes: Buffer): Record<string, unknown> {
    const value = packr.unpack(bytes) as unknown;

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("MsgpackDocumentEncoder: top-level value must be an object.");
    }

    return value as Record<string, unknown>;
  }
}

/** Shared singleton — MessagePack encoder is stateless, no need to instantiate per-call. */
export const msgpackDocumentEncoder: DocumentEncoder = new MsgpackDocumentEncoder();
