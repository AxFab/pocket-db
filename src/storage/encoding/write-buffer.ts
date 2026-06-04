/**
 * Growable write buffer for binary document encoders.
 *
 * Pre-allocates a single Buffer and doubles its capacity when full, replacing
 * the `Buffer.concat(parts)` pattern used in naive encoders. Benefits:
 *
 *  - No small intermediate Buffer objects per field or type marker.
 *  - No two-pass concat (sum sizes → allocate → copy); all writes are
 *    a direct memcpy into already-owned memory.
 *  - `patchInt32LE` enables backpatching size fields whose values are not
 *    known until after the body has been written (e.g. BSON document sizes).
 *  - `writeUtf8` uses `Buffer.byteLength` + `Buffer.write` so strings never
 *    require a temporary Buffer object.
 */
export class WriteBuffer {
  private data: Buffer;
  private pos = 0;

  constructor(initialCapacity = 512) {
    this.data = Buffer.allocUnsafe(initialCapacity);
  }

  /** Bytes written so far. */
  get offset(): number {
    return this.pos;
  }

  private grow(needed: number): void {
    const required = this.pos + needed;
    if (required <= this.data.length) return;

    let capacity = this.data.length;
    do { capacity *= 2; } while (capacity < required);

    const next = Buffer.allocUnsafe(capacity);
    this.data.copy(next, 0, 0, this.pos);
    this.data = next;
  }

  writeByte(b: number): void {
    this.grow(1);
    this.data[this.pos++] = b;
  }

  writeInt32LE(value: number): void {
    this.grow(4);
    this.data.writeInt32LE(value, this.pos);
    this.pos += 4;
  }

  /**
   * Write an int32LE at a previously reserved position without moving the
   * write cursor. Used to backpatch BSON document size fields.
   */
  patchInt32LE(offset: number, value: number): void {
    this.data.writeInt32LE(value, offset);
  }

  writeDoubleLE(value: number): void {
    this.grow(8);
    this.data.writeDoubleLE(value, this.pos);
    this.pos += 8;
  }

  writeDoubleBE(value: number): void {
    this.grow(8);
    this.data.writeDoubleBE(value, this.pos);
    this.pos += 8;
  }

  writeBigInt64LE(value: bigint): void {
    this.grow(8);
    this.data.writeBigInt64LE(value, this.pos);
    this.pos += 8;
  }

  /**
   * Write a UTF-8 string directly into the buffer.
   *
   * Uses `Buffer.byteLength` + `Buffer.write` to avoid creating a temporary
   * `Buffer` object — the main allocation hotspot in naive encoders.
   */
  writeUtf8(str: string): void {
    const byteLen = Buffer.byteLength(str, "utf8");
    this.grow(byteLen);
    this.data.write(str, this.pos, "utf8");
    this.pos += byteLen;
  }

  /** UTF-8 byte length of `str` without allocating a Buffer. */
  static utf8ByteLength(str: string): number {
    return Buffer.byteLength(str, "utf8");
  }

  /**
   * Write a U29 variable-length integer in-place (AMF3 / pocket-db encoding).
   *
   * Inlines the encoding to avoid the small `Buffer` allocation that calling
   * `encodeU29` from `u29.ts` would produce.  Range: 0 – 0x1FFFFFFF.
   */
  writeU29(n: number): void {
    if (n < 0x80) {
      this.grow(1);
      this.data[this.pos++] = n;
    } else if (n < 0x4000) {
      this.grow(2);
      this.data[this.pos++] = 0x80 | (n >> 7);
      this.data[this.pos++] = n & 0x7f;
    } else if (n < 0x200000) {
      this.grow(3);
      this.data[this.pos++] = 0x80 | (n >> 14);
      this.data[this.pos++] = 0x80 | ((n >> 7) & 0x7f);
      this.data[this.pos++] = n & 0x7f;
    } else {
      this.grow(4);
      this.data[this.pos++] = 0x80 | ((n >> 22) & 0x7f);
      this.data[this.pos++] = 0x80 | ((n >> 15) & 0x7f);
      this.data[this.pos++] = 0x80 | ((n >> 8) & 0x7f);
      this.data[this.pos++] = n & 0xff;
    }
  }

  /**
   * Return a new Buffer containing exactly the bytes written so far.
   * The returned Buffer is independent of this WriteBuffer's internal storage.
   */
  toBuffer(): Buffer {
    return Buffer.from(this.data.subarray(0, this.pos));
  }
}
