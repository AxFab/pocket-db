import type { DocumentEncoder } from "./document-encoder.js";

// ---------------------------------------------------------------------------
// BSON type codes (subset used by pocket-db)
// ---------------------------------------------------------------------------

const TYPE_DOUBLE = 0x01;   // 64-bit IEEE 754 little-endian
const TYPE_STRING = 0x02;   // int32 byte-length (incl. null term) + UTF-8 + 0x00
const TYPE_DOCUMENT = 0x03; // nested BSON document
const TYPE_ARRAY = 0x04;    // BSON document with "0", "1", … keys
const TYPE_BOOLEAN = 0x08;  // 0x00 = false, 0x01 = true
const TYPE_NULL = 0x0a;     // no value bytes
const TYPE_INT32 = 0x10;    // 32-bit signed little-endian
const TYPE_INT64 = 0x12;    // 64-bit signed little-endian (used for safe integers outside int32 range)

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** Encode a single document value.  Returns { type, bytes }. */
function encodeValue(value: unknown): { type: number; bytes: Buffer } {
  if (value === null || value === undefined) {
    return { type: TYPE_NULL, bytes: Buffer.alloc(0) };
  }

  if (typeof value === "boolean") {
    const buf = Buffer.alloc(1);
    buf[0] = value ? 0x01 : 0x00;
    return { type: TYPE_BOOLEAN, bytes: buf };
  }

  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      // Fits in int32 — more compact than double.
      const buf = Buffer.alloc(4);
      buf.writeInt32LE(value, 0);
      return { type: TYPE_INT32, bytes: buf };
    }

    if (Number.isInteger(value) && Number.isSafeInteger(value)) {
      // Safe integer outside int32 range — use int64.
      const buf = Buffer.alloc(8);
      buf.writeBigInt64LE(BigInt(value), 0);
      return { type: TYPE_INT64, bytes: buf };
    }

    // Floating-point or non-finite number.
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(value, 0);
    return { type: TYPE_DOUBLE, bytes: buf };
  }

  if (typeof value === "string") {
    const strBuf = Buffer.from(value, "utf8");
    // Format: int32 (byte length including null terminator) + bytes + 0x00
    const buf = Buffer.alloc(4 + strBuf.length + 1);
    buf.writeInt32LE(strBuf.length + 1, 0);
    strBuf.copy(buf, 4);
    buf[4 + strBuf.length] = 0x00;
    return { type: TYPE_STRING, bytes: buf };
  }

  if (Array.isArray(value)) {
    // BSON arrays are encoded as documents with string-ified integer keys.
    const arrayDoc: Record<string, unknown> = {};
    value.forEach((item, i) => {
      arrayDoc[String(i)] = item;
    });
    return { type: TYPE_ARRAY, bytes: encodeDocument(arrayDoc) };
  }

  if (typeof value === "object") {
    return { type: TYPE_DOCUMENT, bytes: encodeDocument(value as Record<string, unknown>) };
  }

  throw new Error(`BsonDocumentEncoder: unsupported value type "${typeof value}".`);
}

/**
 * Encode a plain object as a BSON document.
 *
 * Layout:
 *   int32   total_size  (4 bytes, LE, includes itself and the trailing 0x00)
 *   element...
 *   0x00    terminator
 *
 * Each element:
 *   byte    type
 *   cstring key  (UTF-8 + 0x00)
 *   bytes   value
 */
function encodeDocument(doc: Record<string, unknown>): Buffer {
  const elements: Buffer[] = [];

  for (const [key, value] of Object.entries(doc)) {
    const { type, bytes: valueBytes } = encodeValue(value);

    // key as null-terminated UTF-8
    const keyBuf = Buffer.from(key, "utf8");
    const element = Buffer.alloc(1 + keyBuf.length + 1 + valueBytes.length);
    let offset = 0;
    element[offset++] = type;
    keyBuf.copy(element, offset);
    offset += keyBuf.length;
    element[offset++] = 0x00; // null terminator for key
    valueBytes.copy(element, offset);

    elements.push(element);
  }

  // total = int32 size field (4) + all element bytes + terminator (1)
  const bodyLength = elements.reduce((sum, e) => sum + e.length, 0);
  const totalSize = 4 + bodyLength + 1;

  const result = Buffer.alloc(totalSize);
  result.writeInt32LE(totalSize, 0);

  let pos = 4;
  for (const element of elements) {
    element.copy(result, pos);
    pos += element.length;
  }
  result[pos] = 0x00; // document terminator

  return result;
}

// ---------------------------------------------------------------------------
// Decoding helpers
// ---------------------------------------------------------------------------

interface DecodeResult {
  value: Record<string, unknown>;
  /** Absolute end offset (exclusive) within the source buffer. */
  end: number;
}

/** Read a null-terminated cstring starting at `pos`, return string and new pos. */
function readCString(buf: Buffer, pos: number): { value: string; pos: number } {
  const start = pos;
  while (pos < buf.length && buf[pos] !== 0x00) pos++;
  return { value: buf.subarray(start, pos).toString("utf8"), pos: pos + 1 };
}

/**
 * Decode a BSON document starting at `start` within `buf`.
 * Returns the decoded object and the offset just past the end of the document.
 */
function decodeDocument(buf: Buffer, start: number): DecodeResult {
  const totalSize = buf.readInt32LE(start);
  const docEnd = start + totalSize;
  const doc: Record<string, unknown> = {};

  let pos = start + 4; // skip the int32 size field

  while (pos < docEnd - 1) {
    const type = buf[pos];
    pos += 1;

    if (type === 0x00) break; // terminator reached early

    // Read element key.
    const { value: key, pos: afterKey } = readCString(buf, pos);
    pos = afterKey;

    // Read element value.
    switch (type) {
      case TYPE_NULL:
        doc[key] = null;
        break;

      case TYPE_BOOLEAN:
        doc[key] = buf[pos] !== 0x00;
        pos += 1;
        break;

      case TYPE_DOUBLE:
        doc[key] = buf.readDoubleLE(pos);
        pos += 8;
        break;

      case TYPE_INT32:
        doc[key] = buf.readInt32LE(pos);
        pos += 4;
        break;

      case TYPE_INT64:
        // Return as a JS number; precision is maintained for safe integers.
        doc[key] = Number(buf.readBigInt64LE(pos));
        pos += 8;
        break;

      case TYPE_STRING: {
        const byteLen = buf.readInt32LE(pos); // includes null terminator
        pos += 4;
        doc[key] = buf.subarray(pos, pos + byteLen - 1).toString("utf8");
        pos += byteLen;
        break;
      }

      case TYPE_DOCUMENT: {
        const nested = decodeDocument(buf, pos);
        doc[key] = nested.value;
        pos = nested.end;
        break;
      }

      case TYPE_ARRAY: {
        const nested = decodeDocument(buf, pos);
        // Re-assemble as a JavaScript array using the integer keys.
        const arr: unknown[] = [];
        for (const [k, v] of Object.entries(nested.value)) {
          arr[parseInt(k, 10)] = v;
        }
        doc[key] = arr;
        pos = nested.end;
        break;
      }

      default:
        throw new Error(`BsonDocumentEncoder: unsupported BSON type 0x${type.toString(16)}.`);
    }
  }

  return { value: doc, end: docEnd };
}

// ---------------------------------------------------------------------------
// Public encoder
// ---------------------------------------------------------------------------

/**
 * BSON document encoder (file header byte `'b'`).
 *
 * Uses a minimal subset of the BSON specification (types: double, string,
 * document, array, boolean, null, int32, int64).  The encoding is fully
 * compatible with the BSON 1.1 specification for those types.
 *
 * Benefits over JSON:
 *   - Binary-native: numbers, booleans, and null have fixed-width encodings.
 *   - No string escaping overhead for arbitrary byte values.
 *   - Faster parse for large numeric payloads.
 */
export class BsonDocumentEncoder implements DocumentEncoder {
  encode(document: Record<string, unknown>): Buffer {
    return encodeDocument(document);
  }

  decode(bytes: Buffer): Record<string, unknown> {
    const { value } = decodeDocument(bytes, 0);
    return value;
  }
}

/** Shared singleton — BSON encoder is stateless, no need to instantiate per-call. */
export const bsonEncoder: DocumentEncoder = new BsonDocumentEncoder();
