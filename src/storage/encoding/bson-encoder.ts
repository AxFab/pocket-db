import type { DocumentEncoder } from "./document-encoder.js";
import { WriteBuffer } from "./write-buffer.js";

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
const TYPE_INT64 = 0x12;    // 64-bit signed little-endian (safe integers outside int32 range)

// ---------------------------------------------------------------------------
// Encoding — single-pass WriteBuffer approach
//
// Each element is written directly into a pre-allocated WriteBuffer:
//   type byte  →  cstring key (UTF-8 + 0x00)  →  value bytes
//
// BSON documents embed their own byte length as the first int32.  Since the
// length is not known until the body has been written, we reserve 4 bytes,
// write the body, then backpatch the size with `patchInt32LE`.
// ---------------------------------------------------------------------------

/** Write a null-terminated UTF-8 key string (BSON cstring format). */
function writeCString(key: string, wb: WriteBuffer): void {
  wb.writeUtf8(key);
  wb.writeByte(0x00);
}

/**
 * Write one BSON element (type + key + value) directly into `wb`.
 *
 * Arrays are encoded as BSON documents with string-ified integer keys,
 * which is the standard BSON representation.
 */
function writeElement(key: string, value: unknown, wb: WriteBuffer): void {
  if (value === null || value === undefined) {
    wb.writeByte(TYPE_NULL);
    writeCString(key, wb);
    return; // null has no value bytes
  }

  if (typeof value === "boolean") {
    wb.writeByte(TYPE_BOOLEAN);
    writeCString(key, wb);
    wb.writeByte(value ? 0x01 : 0x00);
    return;
  }

  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      wb.writeByte(TYPE_INT32);
      writeCString(key, wb);
      wb.writeInt32LE(value);
    } else if (Number.isInteger(value) && Number.isSafeInteger(value)) {
      wb.writeByte(TYPE_INT64);
      writeCString(key, wb);
      wb.writeBigInt64LE(BigInt(value));
    } else {
      wb.writeByte(TYPE_DOUBLE);
      writeCString(key, wb);
      wb.writeDoubleLE(value);
    }
    return;
  }

  if (typeof value === "string") {
    wb.writeByte(TYPE_STRING);
    writeCString(key, wb);
    const byteLen = WriteBuffer.utf8ByteLength(value);
    wb.writeInt32LE(byteLen + 1); // length includes the null terminator
    wb.writeUtf8(value);
    wb.writeByte(0x00);
    return;
  }

  if (Array.isArray(value)) {
    wb.writeByte(TYPE_ARRAY);
    writeCString(key, wb);
    writeDocumentBody(wb, () => {
      for (let i = 0; i < value.length; i++) {
        writeElement(String(i), value[i], wb);
      }
    });
    return;
  }

  if (typeof value === "object") {
    wb.writeByte(TYPE_DOCUMENT);
    writeCString(key, wb);
    writeDocumentBody(wb, () => {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        writeElement(k, v, wb);
      }
    });
    return;
  }

  throw new Error(`BsonDocumentEncoder: unsupported value type "${typeof value}".`);
}

/**
 * Write a BSON document frame: reserve 4 bytes for the size, invoke
 * `writeBody` to write all elements, append the 0x00 terminator, then
 * backpatch the size field with the actual byte count.
 */
function writeDocumentBody(wb: WriteBuffer, writeBody: () => void): void {
  const sizePos = wb.offset;
  wb.writeInt32LE(0); // placeholder — will be patched below
  writeBody();
  wb.writeByte(0x00); // document terminator
  wb.patchInt32LE(sizePos, wb.offset - sizePos);
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
    const wb = new WriteBuffer();
    writeDocumentBody(wb, () => {
      for (const [key, value] of Object.entries(document)) {
        writeElement(key, value, wb);
      }
    });
    return wb.toBuffer();
  }

  decode(bytes: Buffer): Record<string, unknown> {
    const { value } = decodeDocument(bytes, 0);
    return value;
  }
}

/** Shared singleton — BSON encoder is stateless, no need to instantiate per-call. */
export const bsonEncoder: DocumentEncoder = new BsonDocumentEncoder();
