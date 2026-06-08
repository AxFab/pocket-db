import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getEncoder, SERIALIZATION_FORMAT_AMF3, SERIALIZATION_FORMAT_BSON, SERIALIZATION_FORMAT_CBOR, SERIALIZATION_FORMAT_JSON, SERIALIZATION_FORMAT_MSGPACK } from "../src/storage/encoding/index.js";
import { JsonDocumentEncoder } from "../src/storage/encoding/json-encoder.js";
import { BsonDocumentEncoder } from "../src/storage/encoding/bson-encoder.js";
import { Amf3DocumentEncoder } from "../src/storage/encoding/amf3-encoder.js";
import { CborDocumentEncoder } from "../src/storage/encoding/cbor-encoder.js";
import { MsgpackDocumentEncoder } from "../src/storage/encoding/msgpack-encoder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Round-trip: encode then decode, assert deep equality. */
function roundtrip(encoder: { encode: (d: Record<string, unknown>) => Buffer; decode: (b: Buffer) => Record<string, unknown> }, doc: Record<string, unknown>): Record<string, unknown> {
  const bytes = encoder.encode(doc);
  return encoder.decode(bytes);
}

// ---------------------------------------------------------------------------
// JSON encoder
// ---------------------------------------------------------------------------

describe("JsonDocumentEncoder", () => {
  const encoder = new JsonDocumentEncoder();

  it("round-trips a flat document", () => {
    const doc = { _id: "abc123", name: "Ada", age: 36, active: true };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips nested objects and arrays", () => {
    const doc = { tags: ["db", "nosql"], meta: { version: 2 } };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips null values", () => {
    const doc = { value: null };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("encodes to valid UTF-8 JSON bytes", () => {
    const doc = { greeting: "héllo" };
    const bytes = encoder.encode(doc);
    assert.equal(JSON.parse(bytes.toString("utf8")).greeting, "héllo");
  });
});

// ---------------------------------------------------------------------------
// BSON encoder
// ---------------------------------------------------------------------------

describe("BsonDocumentEncoder", () => {
  const encoder = new BsonDocumentEncoder();

  it("round-trips a flat document with string and boolean", () => {
    const doc = { _id: "aabbcc", name: "Grace", active: true };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips int32 numbers", () => {
    const doc = { count: 42, negative: -7 };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips large safe integers via int64", () => {
    const large = 2 ** 33; // outside int32 range, but safe integer
    const doc = { big: large };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips floating-point numbers via double", () => {
    const doc = { pi: Math.PI, e: Math.E };
    const result = roundtrip(encoder, doc);
    assert.ok(Math.abs((result.pi as number) - Math.PI) < 1e-15);
    assert.ok(Math.abs((result.e as number) - Math.E) < 1e-15);
  });

  it("round-trips null values", () => {
    const doc = { empty: null };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips arrays", () => {
    const doc = { tags: ["alpha", "beta", "gamma"] };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips nested documents", () => {
    const doc = { meta: { version: 3, author: "Ada" } };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips mixed nested structure", () => {
    const doc = {
      _id: "deadbeef01234567",
      scores: [10, 20, 30],
      profile: { city: "Paris", active: false },
      ratio: 0.75,
      notes: null
    };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("produces a buffer whose first 4 bytes encode the document size (LE int32)", () => {
    const doc = { x: 1 };
    const bytes = encoder.encode(doc);
    const size = bytes.readInt32LE(0);
    assert.equal(size, bytes.length);
  });

  it("handles an empty document", () => {
    assert.deepEqual(roundtrip(encoder, {}), {});
  });

  it("handles unicode strings", () => {
    const doc = { greeting: "こんにちは" };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });
});

// ---------------------------------------------------------------------------
// AMF3 encoder
// ---------------------------------------------------------------------------

describe("Amf3DocumentEncoder", () => {
  const encoder = new Amf3DocumentEncoder();

  it("round-trips a flat document with string and boolean", () => {
    const doc = { _id: "aabbcc", name: "Grace", active: true };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips integers in the 29-bit signed range", () => {
    const doc = { pos: 268435455, zero: 0, neg: -268435456 };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips negative integers", () => {
    const doc = { minus: -1, big: -100000 };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips large integers outside 29-bit range as doubles", () => {
    const doc = { big: 2 ** 29 }; // 536_870_912 — just outside AMF3 int range
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips floating-point numbers as doubles", () => {
    const doc = { pi: Math.PI, e: Math.E, half: 0.5 };
    const result = roundtrip(encoder, doc);
    assert.ok(Math.abs((result.pi as number) - Math.PI) < 1e-15);
    assert.ok(Math.abs((result.e as number) - Math.E) < 1e-15);
    assert.equal(result.half, 0.5);
  });

  it("round-trips null values", () => {
    const doc = { empty: null };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips arrays", () => {
    const doc = { tags: ["alpha", "beta", "gamma"] };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips nested documents", () => {
    const doc = { meta: { version: 3, author: "Ada" } };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips mixed nested structure", () => {
    const doc = {
      _id: "deadbeef01234567",
      scores: [10, 20, 30],
      profile: { city: "Paris", active: false },
      ratio: 0.75,
      notes: null
    };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("handles an empty document", () => {
    assert.deepEqual(roundtrip(encoder, {}), {});
  });

  it("handles unicode strings", () => {
    const doc = { greeting: "こんにちは" };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("starts encoded bytes with OBJECT_MARKER (0x0a)", () => {
    const bytes = encoder.encode({ x: 1 });
    assert.equal(bytes[0], 0x0a);
  });

  it("encodes integers below the 29-bit range as doubles", () => {
    // AMF3 min int = -(2^28). One below that must fall back to double.
    const doc = { v: -(1 << 28) - 1 };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("throws when top-level decoded value is not an object", () => {
    // Manually craft bytes starting with TRUE_MARKER (0x03) — not an object.
    const buf = Buffer.from([0x03]);
    assert.throws(() => encoder.decode(buf), /top-level value must be an object/);
  });
});

// ---------------------------------------------------------------------------
// CBOR encoder
// ---------------------------------------------------------------------------

describe("CborDocumentEncoder", () => {
  const encoder = new CborDocumentEncoder();

  it("round-trips a flat document with string and boolean", () => {
    const doc = { _id: "aabbcc", name: "Grace", active: true };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips integer numbers", () => {
    const doc = { count: 42, negative: -7, zero: 0 };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips large safe integers", () => {
    const doc = { big: 2 ** 33 };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips floating-point numbers", () => {
    const doc = { pi: Math.PI, e: Math.E };
    const result = roundtrip(encoder, doc);
    assert.ok(Math.abs((result.pi as number) - Math.PI) < 1e-15);
    assert.ok(Math.abs((result.e as number) - Math.E) < 1e-15);
  });

  it("round-trips null values", () => {
    const doc = { empty: null };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips arrays", () => {
    const doc = { tags: ["alpha", "beta", "gamma"] };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips nested documents", () => {
    const doc = { meta: { version: 3, author: "Ada" } };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips mixed nested structure", () => {
    const doc = {
      _id: "deadbeef01234567",
      scores: [10, 20, 30],
      profile: { city: "Paris", active: false },
      ratio: 0.75,
      notes: null
    };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("handles an empty document", () => {
    assert.deepEqual(roundtrip(encoder, {}), {});
  });

  it("handles unicode strings", () => {
    const doc = { greeting: "こんにちは" };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("throws when top-level decoded value is not an object", () => {
    // CBOR integer 1 encodes to a single byte 0x01.
    const buf = Buffer.from([0x01]);
    assert.throws(() => encoder.decode(buf), /top-level value must be an object/);
  });
});

// ---------------------------------------------------------------------------
// MessagePack encoder
// ---------------------------------------------------------------------------

describe("MsgpackDocumentEncoder", () => {
  const encoder = new MsgpackDocumentEncoder();

  it("round-trips a flat document with string and boolean", () => {
    const doc = { _id: "aabbcc", name: "Grace", active: true };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips integer numbers", () => {
    const doc = { count: 42, negative: -7, zero: 0 };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips large safe integers", () => {
    const doc = { big: 2 ** 33 };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips floating-point numbers", () => {
    const doc = { pi: Math.PI, e: Math.E };
    const result = roundtrip(encoder, doc);
    assert.ok(Math.abs((result.pi as number) - Math.PI) < 1e-15);
    assert.ok(Math.abs((result.e as number) - Math.E) < 1e-15);
  });

  it("round-trips null values", () => {
    const doc = { empty: null };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips arrays", () => {
    const doc = { tags: ["alpha", "beta", "gamma"] };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips nested documents", () => {
    const doc = { meta: { version: 3, author: "Ada" } };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("round-trips mixed nested structure", () => {
    const doc = {
      _id: "deadbeef01234567",
      scores: [10, 20, 30],
      profile: { city: "Paris", active: false },
      ratio: 0.75,
      notes: null
    };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("handles an empty document", () => {
    assert.deepEqual(roundtrip(encoder, {}), {});
  });

  it("handles unicode strings", () => {
    const doc = { greeting: "こんにちは" };
    assert.deepEqual(roundtrip(encoder, doc), doc);
  });

  it("throws when top-level decoded value is not an object", () => {
    // MessagePack true encodes to 0xc3.
    const buf = Buffer.from([0xc3]);
    assert.throws(() => encoder.decode(buf), /top-level value must be an object/);
  });
});

// ---------------------------------------------------------------------------
// getEncoder factory
// ---------------------------------------------------------------------------

describe("getEncoder", () => {
  it("returns a JsonDocumentEncoder for format byte 'j'", () => {
    const encoder = getEncoder(SERIALIZATION_FORMAT_JSON);
    assert.ok(encoder instanceof JsonDocumentEncoder);
  });

  it("returns a BsonDocumentEncoder for format byte 'b'", () => {
    const encoder = getEncoder(SERIALIZATION_FORMAT_BSON);
    assert.ok(encoder instanceof BsonDocumentEncoder);
  });

  it("returns an Amf3DocumentEncoder for format byte 'a'", () => {
    const encoder = getEncoder(SERIALIZATION_FORMAT_AMF3);
    assert.ok(encoder instanceof Amf3DocumentEncoder);
  });

  it("returns a CborDocumentEncoder for format byte 'c'", () => {
    const encoder = getEncoder(SERIALIZATION_FORMAT_CBOR);
    assert.ok(encoder instanceof CborDocumentEncoder);
  });

  it("returns a MsgpackDocumentEncoder for format byte 'm'", () => {
    const encoder = getEncoder(SERIALIZATION_FORMAT_MSGPACK);
    assert.ok(encoder instanceof MsgpackDocumentEncoder);
  });

  it("throws for an unknown format byte", () => {
    assert.throws(() => getEncoder(0x7a /* 'z' */), /Unsupported serialization format/);
  });
});
