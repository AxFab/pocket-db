import { closeSync, existsSync, fsyncSync, fstatSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs";
import {
  FILE_HEADER_BYTES,
  FORMAT_MAJOR_VERSION,
  FORMAT_MINOR_VERSION,
  MAGIC_HEADER,
  MAGIC_HEADER_BYTES,
  OPERATION_CRC32_BYTES,
  OPERATION_HEADER_BYTES,
  OPERATION_IDENTIFIER_BYTES,
  SERIALIZATION_FORMAT,
  SERIALIZATION_FORMAT_AMF3,
  SERIALIZATION_FORMAT_BSON,
  SERIALIZATION_VERSION
} from "./constants.js";
import { decodeOperationRecord, encodeOperationRecord, readOperationFromBuffer, type OperationRecord } from "./operation-record.js";
import type { DurabilityMode } from '../types.js'

/**
 * Default sliding-window size for {@link FileStorage.readOperations}. Trades
 * syscall count against peak memory: at pocket-db's typical record sizes this
 * reads on the order of thousands of records per underlying `readSync` call,
 * while keeping resident memory bounded to a small multiple of this value
 * regardless of how large the log itself is.
 */
export const DEFAULT_REPLAY_CHUNK_BYTES = 8 * 1024 * 1024;

export class FileStorage {
  private currentOffset: number;

  private constructor(
    private readonly fd: number,
    readonly path: string,
    initialOffset: number,
    private readonly durability: DurabilityMode,
    /** Raw byte value of the serialization format field in the file header. */
    readonly serializationFormat: number
  ) {
    this.currentOffset = initialOffset;
  }

  /**
   * Current size of the file on disk in bytes (file header + every record).
   * Maintained in memory, so reading it costs no syscall.
   */
  get size(): number {
    return this.currentOffset;
  }

  /**
   * Open or create a database file at `path`.
   *
   * @param path - Filesystem path to the `.pdb` file.
   * @param durability - fsync policy (`"relaxed"` by default).
   * @param newFileFormatByte - Serialization format byte to write into the
   *   header when **creating** a new file.  Ignored when opening an existing
   *   file (the format is read from the existing header instead).
   *   Defaults to {@link SERIALIZATION_FORMAT} (`'j'` = JSON).
   */
  static open(
    path: string,
    durability: DurabilityMode = "relaxed",
    newFileFormatByte: number = SERIALIZATION_FORMAT
  ): FileStorage {
    if (!existsSync(path)) {
      const fd = openSync(path, "wx+");
      const header = Buffer.alloc(FILE_HEADER_BYTES);
      MAGIC_HEADER_BYTES.copy(header, 0);
      header.writeUInt8(FORMAT_MAJOR_VERSION, MAGIC_HEADER_BYTES.byteLength);
      header.writeUInt8(FORMAT_MINOR_VERSION, MAGIC_HEADER_BYTES.byteLength + 1);
      header.writeUInt8(newFileFormatByte, MAGIC_HEADER_BYTES.byteLength + 2);
      header.writeUInt8(SERIALIZATION_VERSION, MAGIC_HEADER_BYTES.byteLength + 3);
      writeSync(fd, header, 0, header.length, 0);
      return new FileStorage(fd, path, FILE_HEADER_BYTES, durability, newFileFormatByte);
    }

    const fd = openSync(path, "r+");
    const header = Buffer.alloc(FILE_HEADER_BYTES);
    const bytesRead = readSync(fd, header, 0, header.length, 0);

    if (bytesRead < FILE_HEADER_BYTES) {
      closeSync(fd);
      throw new Error(`Invalid Pocket DB file: header too short.`);
    }

    const magic = header.subarray(0, MAGIC_HEADER_BYTES.byteLength);

    if (!magic.equals(MAGIC_HEADER_BYTES)) {
      closeSync(fd);
      throw new Error(`Invalid Pocket DB file: expected "${MAGIC_HEADER}" header.`);
    }

    const formatMajor = header.readUInt8(MAGIC_HEADER_BYTES.byteLength);

    if (formatMajor !== FORMAT_MAJOR_VERSION) {
      closeSync(fd);
      throw new Error(`Unsupported Pocket DB format version: ${formatMajor}.`);
    }

    const serializationFormat = header.readUInt8(MAGIC_HEADER_BYTES.byteLength + 2);
    const supportedFormats = new Set([SERIALIZATION_FORMAT, SERIALIZATION_FORMAT_BSON, SERIALIZATION_FORMAT_AMF3]);

    if (!supportedFormats.has(serializationFormat)) {
      closeSync(fd);
      throw new Error(`Unsupported serialization format: ${String.fromCharCode(serializationFormat)}.`);
    }

    const serializationVersion = header.readUInt8(MAGIC_HEADER_BYTES.byteLength + 3);

    if (serializationVersion !== SERIALIZATION_VERSION) {
      closeSync(fd);
      throw new Error(`Unsupported serialization version: ${serializationVersion}.`);
    }

    const fileSize = fstatSync(fd).size;
    return new FileStorage(fd, path, fileSize, durability, serializationFormat);
  }

  close(): void {
    closeSync(this.fd);
  }

  appendOperation(identifier: Buffer, payload: Buffer): number {
    const offset = this.currentOffset;
    const record = encodeOperationRecord({ identifier, payload });

    writeAll(this.fd, record, offset);
    this.currentOffset += record.byteLength;

    if (this.durability === "strict") {
      fsyncSync(this.fd);
    }

    return offset;
  }

  readOperationAtOffset(offset: number): OperationRecord {
    const header = readExact(this.fd, OPERATION_HEADER_BYTES, offset);
    const payloadLength = header.readUInt32BE(OPERATION_IDENTIFIER_BYTES);
    const payload = readExact(this.fd, payloadLength, offset + OPERATION_HEADER_BYTES);
    const checksum = readExact(
      this.fd,
      OPERATION_CRC32_BYTES,
      offset + OPERATION_HEADER_BYTES + payloadLength
    );

    const operation = decodeOperationRecord(Buffer.concat([header, payload]), checksum);

    return {
      ...operation,
      byteLength: OPERATION_HEADER_BYTES + payloadLength + OPERATION_CRC32_BYTES
    };
  }

  readRawBytes(offset: number, length: number): Buffer {
    return readExact(this.fd, length, offset);
  }

  writeRawAt(offset: number, data: Buffer): void {
    writeAll(this.fd, data, offset);
  }

  truncateTo(newSize: number): void {
    ftruncateSync(this.fd, newSize);
    this.currentOffset = newSize;
  }

  /**
   * Reads the minimum contiguous byte range that covers every offset in
   * `offsets`: from the lowest offset to the end of the record starting at
   * the highest. Used by the cursor's multi-candidate read path so a query
   * only pulls in the part of the log its candidates actually live in,
   * instead of the whole file (see `docs/adr/0016-bounded-candidate-range-read.md`).
   *
   * The record at the highest offset isn't known to end anywhere in
   * particular until its length is read, so this costs one small header read
   * (8 bytes) before the main range read — negligible next to the bytes it
   * saves skipping.
   *
   * `offsets` must be non-empty. The returned buffer is independent of the
   * file descriptor and remains valid after the file is written to or closed;
   * `rangeStart` is the absolute file offset the buffer's first byte
   * corresponds to (callers index into it as `offset - rangeStart`, not
   * `offset - FILE_HEADER_BYTES`).
   */
  readBulkRange(offsets: readonly number[]): { buffer: Buffer; rangeStart: number } {
    let minOffset = offsets[0];
    let maxOffset = offsets[0];

    for (const offset of offsets) {
      if (offset < minOffset) minOffset = offset;
      if (offset > maxOffset) maxOffset = offset;
    }

    const maxHeader = readExact(this.fd, OPERATION_HEADER_BYTES, maxOffset);
    const maxPayloadLength = maxHeader.readUInt32BE(OPERATION_IDENTIFIER_BYTES);
    const maxRecordEnd = maxOffset + OPERATION_HEADER_BYTES + maxPayloadLength + OPERATION_CRC32_BYTES;

    const rangeEnd = Math.min(maxRecordEnd, this.currentOffset);
    const buffer = readExact(this.fd, rangeEnd - minOffset, minOffset);

    return { buffer, rangeStart: minOffset };
  }

  /**
   * Reads and parses operation records sequentially, without ever holding the
   * whole log in memory at once.
   *
   * Maintains a sliding read window of `chunkBytes` (default
   * {@link DEFAULT_REPLAY_CHUNK_BYTES}): it fills the window from disk,
   * yields every record it can fully satisfy from what's buffered, then
   * refills once the remainder can't cover the next record. A single record
   * larger than `chunkBytes` still works correctly — the window grows just
   * enough to hold that one record and shrinks back on the next refill. Peak
   * memory is therefore O(chunkBytes + largest single record), not O(file
   * size) — see `docs/adr/0016-bounded-candidate-range-read.md`'s sibling
   * decision on bounded replay memory.
   *
   * Every current consumer (`loadCollections`, `computeStorageStats`,
   * `compact`) already iterates with a plain `for...of` and never relied on
   * random access or `.length`, so this generator is a drop-in replacement
   * for the previous "read the whole log into one Buffer, parse every record
   * into an array" implementation — no caller changes required. `identifier`
   * and `payload` on each yielded record are independent copies (see
   * {@link readOperationFromBuffer}), so callers may hold onto them past the
   * next window refill without risk of the underlying window buffer changing
   * under them.
   */
  *readOperations(chunkBytes: number = DEFAULT_REPLAY_CHUNK_BYTES): Generator<OperationRecord> {
    const end = this.currentOffset;
    let fileOffset = FILE_HEADER_BYTES;
    let window: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    const fill = (minBytes: number): boolean => {
      while (window.length < minBytes) {
        const remaining = end - (fileOffset + window.length);
        if (remaining <= 0) {
          return window.length >= minBytes;
        }

        const readLength = Math.min(Math.max(chunkBytes, minBytes - window.length), remaining);
        const next = readExact(this.fd, readLength, fileOffset + window.length);
        window = window.length === 0 ? next : Buffer.concat([window, next]);
      }

      return true;
    };

    while (true) {
      if (!fill(OPERATION_HEADER_BYTES)) {
        if (window.length === 0) break;
        throw new Error("Invalid operation record: unexpected end of file.");
      }

      const payloadLength = window.readUInt32BE(OPERATION_IDENTIFIER_BYTES);
      const recordLength = OPERATION_HEADER_BYTES + payloadLength + OPERATION_CRC32_BYTES;

      if (!fill(recordLength)) {
        throw new Error("Invalid operation record: unexpected end of file.");
      }

      const operation = readOperationFromBuffer(window, 0);
      yield { ...operation, offset: fileOffset };

      fileOffset += recordLength;
      window = window.subarray(recordLength);
    }
  }
}

function writeAll(fd: number, buffer: Buffer, position: number): void {
  let written = 0;

  while (written < buffer.byteLength) {
    written += writeSync(fd, buffer, written, buffer.byteLength - written, position + written);
  }
}

function readExact(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;

  while (bytesRead < length) {
    const currentRead = readSync(fd, buffer, bytesRead, length - bytesRead, position + bytesRead);

    if (currentRead === 0) {
      throw new Error("Invalid operation record: unexpected end of file.");
    }

    bytesRead += currentRead;
  }

  return buffer;
}
