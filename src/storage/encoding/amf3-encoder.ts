import type { DocumentEncoder } from "./document-encoder.js";
import { decodeU29 } from "../u29.js";
import { WriteBuffer } from "./write-buffer.js";

// ---------------------------------------------------------------------------
// AMF3 type markers (subset used by pocket-db)
// Ref: Action Message Format – AMF 3 specification §3.1
// ---------------------------------------------------------------------------

const UNDEFINED_MARKER = 0x00;
const NULL_MARKER      = 0x01;
const FALSE_MARKER     = 0x02;
const TRUE_MARKER      = 0x03;
const INTEGER_MARKER   = 0x04; // 29-bit signed integer encoded as U29
const DOUBLE_MARKER    = 0x05; // 64-bit IEEE 754 double, big-endian
const STRING_MARKER    = 0x06; // U29 (length<<1|1) + UTF-8 bytes
const ARRAY_MARKER     = 0x09; // U29 (count<<1|1) + assoc pairs + dense items
const OBJECT_MARKER    = 0x0a; // U29 trait flags + class name + members

// ---------------------------------------------------------------------------
// AMF3 integer range: 29-bit two's complement
// ---------------------------------------------------------------------------

/** Minimum value that fits in a 29-bit signed integer. */
const AMF3_INT_MIN = -(1 << 28); // -268_435_456

/** Maximum value that fits in a 29-bit signed integer. */
const AMF3_INT_MAX = (1 << 28) - 1; // 268_435_455

/**
 * AMF3 object-traits U29 for an **anonymous dynamic object** with no sealed
 * members:
 *   bit 0 = 1  (inline, not an object-reference)
 *   bit 1 = 1  (inline traits, not a traits-reference)
 *   bit 2 = 0  (not externalizable)
 *   bit 3 = 1  (dynamic — key/value pairs follow)
 *   bits 4+ = 0 (0 sealed members)
 *   → 0b00001011 = 0x0b
 */
const DYNAMIC_OBJECT_TRAIT = 0x0b;

// ---------------------------------------------------------------------------
// String helpers (no string-reference table — always inline)
// ---------------------------------------------------------------------------

/**
 * Write a bare AMF3 string (no type marker) into `wb`: U29 header + UTF-8 bytes.
 *
 * Used for object keys, class names, and associative array keys.
 * The empty string writes a single byte (0x01).
 */
function writeRawString(str: string, wb: WriteBuffer): void {
  wb.writeU29((WriteBuffer.utf8ByteLength(str) << 1) | 1);
  wb.writeUtf8(str);
}

/**
 * Decode a bare AMF3 string starting at `buf[offset]`.
 * Returns the string value and total bytes consumed (header + data).
 */
function decodeRawString(buf: Buffer, offset: number): { value: string; bytesRead: number } {
  const { value: u29, bytesRead: headerBytes } = decodeU29(buf, offset);

  if ((u29 & 1) === 0) {
    // Low bit 0 → string reference.  We never write references.
    throw new Error("Amf3DocumentEncoder: string references are not supported.");
  }

  const byteLength = u29 >> 1;
  const value = buf.subarray(offset + headerBytes, offset + headerBytes + byteLength).toString("utf8");
  return { value, bytesRead: headerBytes + byteLength };
}

// ---------------------------------------------------------------------------
// Value encoding — WriteBuffer-based (no intermediate Buffer allocations)
// ---------------------------------------------------------------------------

function writeValue(value: unknown, wb: WriteBuffer): void {
  if (value === null || value === undefined) {
    wb.writeByte(NULL_MARKER);
    return;
  }

  if (typeof value === "boolean") {
    wb.writeByte(value ? TRUE_MARKER : FALSE_MARKER);
    return;
  }

  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= AMF3_INT_MIN && value <= AMF3_INT_MAX) {
      // Encode as 29-bit signed integer.  Negative values are stored in
      // two's-complement within the 29-bit range, i.e. value + 2^29.
      wb.writeByte(INTEGER_MARKER);
      wb.writeU29(value < 0 ? value + 0x20000000 : value);
    } else {
      // Floating-point or integer outside the 29-bit range → double (big-endian).
      wb.writeByte(DOUBLE_MARKER);
      wb.writeDoubleBE(value);
    }
    return;
  }

  if (typeof value === "string") {
    wb.writeByte(STRING_MARKER);
    writeRawString(value, wb);
    return;
  }

  if (Array.isArray(value)) {
    // Dense array: ARRAY_MARKER + U29 count + empty assoc terminator + elements.
    wb.writeByte(ARRAY_MARKER);
    wb.writeU29((value.length << 1) | 1);
    wb.writeByte(0x01); // empty string key — terminates associative section
    for (const item of value) writeValue(item, wb);
    return;
  }

  if (typeof value === "object") {
    writeObject(value as Record<string, unknown>, wb);
    return;
  }

  throw new Error(`Amf3DocumentEncoder: unsupported value type "${typeof value}".`);
}

/**
 * Write a plain object as an anonymous dynamic AMF3 object into `wb`.
 *
 * Layout:
 *   0x0a          — OBJECT_MARKER
 *   0x0b          — trait U29 (inline, dynamic, 0 sealed members)
 *   0x01          — class name (empty string = anonymous)
 *   [key value]…  — bare string key + typed value for each property
 *   0x01          — empty string key (terminates dynamic section)
 *
 * Undefined property values are silently omitted (matches JSON behaviour).
 */
function writeObject(obj: Record<string, unknown>, wb: WriteBuffer): void {
  wb.writeByte(OBJECT_MARKER);
  wb.writeU29(DYNAMIC_OBJECT_TRAIT);
  wb.writeByte(0x01); // anonymous class name (empty string)

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue; // skip undefined (matches JSON.stringify)
    writeRawString(key, wb);
    writeValue(value, wb);
  }

  wb.writeByte(0x01); // empty key terminates dynamic section
}

// ---------------------------------------------------------------------------
// Value decoding
// ---------------------------------------------------------------------------

interface Amf3DecodeResult {
  value: unknown;
  bytesRead: number;
}

function decodeValue(buf: Buffer, offset: number): Amf3DecodeResult {
  const marker = buf[offset];

  switch (marker) {
    case UNDEFINED_MARKER:
    case NULL_MARKER:
      return { value: null, bytesRead: 1 };

    case FALSE_MARKER:
      return { value: false, bytesRead: 1 };

    case TRUE_MARKER:
      return { value: true, bytesRead: 1 };

    case INTEGER_MARKER: {
      const { value: u29, bytesRead } = decodeU29(buf, offset + 1);
      // The sign bit occupies bit 28 of the U29 value.
      // If set, convert from 29-bit unsigned to signed: value = u29 - 2^29.
      const value = u29 >= 0x10000000 ? u29 - 0x20000000 : u29;
      return { value, bytesRead: 1 + bytesRead };
    }

    case DOUBLE_MARKER:
      return { value: buf.readDoubleBE(offset + 1), bytesRead: 9 };

    case STRING_MARKER: {
      const { value, bytesRead } = decodeRawString(buf, offset + 1);
      return { value, bytesRead: 1 + bytesRead };
    }

    case ARRAY_MARKER: {
      const { value, bytesRead } = decodeArray(buf, offset + 1);
      return { value, bytesRead: 1 + bytesRead };
    }

    case OBJECT_MARKER: {
      const { value, bytesRead } = decodeObject(buf, offset + 1);
      return { value, bytesRead: 1 + bytesRead };
    }

    default:
      throw new Error(`Amf3DocumentEncoder: unsupported AMF3 type 0x${marker.toString(16)}.`);
  }
}

function decodeArray(buf: Buffer, offset: number): { value: unknown[]; bytesRead: number } {
  let pos = 0;

  const { value: u29, bytesRead: headerBytes } = decodeU29(buf, offset);
  pos += headerBytes;

  if ((u29 & 1) === 0) {
    throw new Error("Amf3DocumentEncoder: array references are not supported.");
  }

  const denseCount = u29 >> 1;

  // Consume the associative section (terminated by empty string key).
  // We don't preserve associative entries — they're not used by pocket-db.
  for (;;) {
    const { value: key, bytesRead: keyBytes } = decodeRawString(buf, offset + pos);
    pos += keyBytes;
    if (key === "") break;
    const { bytesRead: valueBytes } = decodeValue(buf, offset + pos);
    pos += valueBytes;
  }

  // Read dense elements in order.
  const arr: unknown[] = [];

  for (let i = 0; i < denseCount; i++) {
    const { value, bytesRead: valueBytes } = decodeValue(buf, offset + pos);
    arr.push(value);
    pos += valueBytes;
  }

  return { value: arr, bytesRead: pos };
}

function decodeObject(buf: Buffer, offset: number): { value: Record<string, unknown>; bytesRead: number } {
  let pos = 0;

  const { value: traitU29, bytesRead: traitBytes } = decodeU29(buf, offset);
  pos += traitBytes;

  // bit 0 = 0 → object reference (not produced by our encoder)
  if ((traitU29 & 1) === 0) {
    throw new Error("Amf3DocumentEncoder: object references are not supported.");
  }

  // bits 1-0 = 01 → traits reference (not produced by our encoder)
  if ((traitU29 & 3) === 1) {
    throw new Error("Amf3DocumentEncoder: traits references are not supported.");
  }

  // bits 1-0 = 11 → inline traits
  const isExternalizable = Boolean((traitU29 >> 2) & 1);
  const isDynamic        = Boolean((traitU29 >> 3) & 1);
  const sealedCount      = traitU29 >> 4;

  if (isExternalizable) {
    throw new Error("Amf3DocumentEncoder: externalizable objects are not supported.");
  }

  // Skip class name (always the empty string for anonymous objects).
  const { bytesRead: classNameBytes } = decodeRawString(buf, offset + pos);
  pos += classNameBytes;

  const obj: Record<string, unknown> = {};

  // Sealed member names.
  const sealedNames: string[] = [];

  for (let i = 0; i < sealedCount; i++) {
    const { value: name, bytesRead } = decodeRawString(buf, offset + pos);
    sealedNames.push(name);
    pos += bytesRead;
  }

  // Sealed member values.
  for (const name of sealedNames) {
    const { value, bytesRead } = decodeValue(buf, offset + pos);
    obj[name] = value;
    pos += bytesRead;
  }

  // Dynamic key–value pairs, terminated by an empty-string key.
  if (isDynamic) {
    for (;;) {
      const { value: key, bytesRead: keyBytes } = decodeRawString(buf, offset + pos);
      pos += keyBytes;
      if (key === "") break;
      const { value, bytesRead: valueBytes } = decodeValue(buf, offset + pos);
      obj[key] = value;
      pos += valueBytes;
    }
  }

  return { value: obj, bytesRead: pos };
}

// ---------------------------------------------------------------------------
// Public encoder
// ---------------------------------------------------------------------------

/**
 * AMF3 (Action Message Format 3) document encoder.
 * File header serialization byte: `'a'` (0x61).
 *
 * Implements a minimal subset of the AMF3 specification (Adobe, 2006) that
 * covers all value types used by pocket-db documents:
 *
 * | AMF3 marker  | JS type                                             |
 * |-------------|-----------------------------------------------------|
 * | null   0x01 | `null` or `undefined`                               |
 * | false  0x02 | `false`                                             |
 * | true   0x03 | `true`                                              |
 * | int    0x04 | integer in [-2²⁸, 2²⁸−1] — U29 two's complement   |
 * | double 0x05 | other numbers — 64-bit big-endian IEEE 754          |
 * | string 0x06 | `string` — inline UTF-8, no reference table        |
 * | array  0x09 | `Array`  — dense-only, no associative entries       |
 * | object 0x0a | plain object — anonymous dynamic, no sealed members |
 *
 * Integers outside the 29-bit range are silently promoted to doubles.
 * The AMF3 string/object reference tables are not used during encoding;
 * reference markers encountered during decoding throw an error.
 */
export class Amf3DocumentEncoder implements DocumentEncoder {
  encode(document: Record<string, unknown>): Buffer {
    const wb = new WriteBuffer();
    writeObject(document, wb);
    return wb.toBuffer();
  }

  decode(bytes: Buffer): Record<string, unknown> {
    const { value } = decodeValue(bytes, 0);

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Amf3DocumentEncoder: top-level value must be an object.");
    }

    return value as Record<string, unknown>;
  }
}

/** Shared singleton — AMF3 encoder is stateless, no need to instantiate per-call. */
export const amf3Encoder: DocumentEncoder = new Amf3DocumentEncoder();
