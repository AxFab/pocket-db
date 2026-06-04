import { closeSync, existsSync, fsyncSync, fstatSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs";
import {
  FILE_HEADER_BYTES,
  FORMAT_HEADER_BYTES,
  FORMAT_MAJOR_VERSION,
  FORMAT_MINOR_VERSION,
  MAGIC_HEADER,
  MAGIC_HEADER_BYTES,
  OPERATION_CRC32_BYTES,
  OPERATION_HEADER_BYTES,
  OPERATION_IDENTIFIER_BYTES,
  SERIALIZATION_FORMAT,
  SERIALIZATION_VERSION
} from "./constants.js";
import { decodeOperationRecord, encodeOperationRecord, readOperationFromBuffer, type OperationRecord } from "./operation-record.js";
import type { DurabilityMode } from '../types.js'

export class FileStorage {
  private currentOffset: number;

  private constructor(
    private readonly fd: number,
    readonly path: string,
    initialOffset: number,
    private readonly durability: DurabilityMode
  ) {
    this.currentOffset = initialOffset;
  }

  static open(path: string, durability: DurabilityMode = "relaxed"): FileStorage {
    if (!existsSync(path)) {
      const fd = openSync(path, "wx+");
      const header = Buffer.alloc(FILE_HEADER_BYTES);
      MAGIC_HEADER_BYTES.copy(header, 0);
      header.writeUInt8(FORMAT_MAJOR_VERSION, MAGIC_HEADER_BYTES.byteLength);
      header.writeUInt8(FORMAT_MINOR_VERSION, MAGIC_HEADER_BYTES.byteLength + 1);
      header.writeUInt8(SERIALIZATION_FORMAT, MAGIC_HEADER_BYTES.byteLength + 2);
      header.writeUInt8(SERIALIZATION_VERSION, MAGIC_HEADER_BYTES.byteLength + 3);
      writeSync(fd, header, 0, header.length, 0);
      return new FileStorage(fd, path, FILE_HEADER_BYTES, durability);
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

    if (serializationFormat !== SERIALIZATION_FORMAT) {
      closeSync(fd);
      throw new Error(`Unsupported serialization format: ${String.fromCharCode(serializationFormat)}.`);
    }

    const serializationVersion = header.readUInt8(MAGIC_HEADER_BYTES.byteLength + 3);

    if (serializationVersion !== SERIALIZATION_VERSION) {
      closeSync(fd);
      throw new Error(`Unsupported serialization version: ${serializationVersion}.`);
    }

    const fileSize = fstatSync(fd).size;
    return new FileStorage(fd, path, fileSize, durability);
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
   * Read the entire operation log (everything after the file header) into a
   * single in-memory Buffer. One syscall regardless of how many records exist.
   *
   * The returned buffer is independent of the file descriptor and remains valid
   * after the file is written to or closed.
   */
  readBulk(): Buffer {
    const length = this.currentOffset - FILE_HEADER_BYTES;

    if (length <= 0) {
      return Buffer.alloc(0);
    }

    return readExact(this.fd, length, FILE_HEADER_BYTES);
  }

  /**
   * Read and parse all operation records sequentially.
   *
   * Internally performs a single bulk read of the operation log and parses
   * every record from the in-memory buffer, replacing the previous approach
   * of one `readSync` per record.
   */
  readOperations(): OperationRecord[] {
    const bulk = this.readBulk();

    if (bulk.length === 0) {
      return [];
    }

    const operations: OperationRecord[] = [];
    let relOffset = 0;

    while (relOffset < bulk.length) {
      const operation = readOperationFromBuffer(bulk, relOffset);
      operations.push({ ...operation, offset: FILE_HEADER_BYTES + relOffset });
      relOffset += operation.byteLength;
    }

    return operations;
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
