import {
  OPERATION_CRC32_BYTES,
  OPERATION_HEADER_BYTES,
  OPERATION_IDENTIFIER_BYTES,
  OPERATION_LENGTH_BYTES
} from "./constants.js";
import { crc32 } from "./crc32.js";

export interface OperationRecord {
  identifier: Buffer;
  payload: Buffer;
  byteLength?: number;
  offset?: number;
}

export function encodeOperationRecord(operation: OperationRecord): Buffer {
  assertOperationIdentifier(operation.identifier);

  const payloadLength = operation.payload.byteLength;
  const bytesBeforeChecksum = Buffer.alloc(OPERATION_HEADER_BYTES + payloadLength);

  operation.identifier.copy(bytesBeforeChecksum, 0);
  bytesBeforeChecksum.writeUInt32BE(payloadLength, OPERATION_IDENTIFIER_BYTES);
  operation.payload.copy(bytesBeforeChecksum, OPERATION_HEADER_BYTES);

  const record = Buffer.alloc(bytesBeforeChecksum.byteLength + OPERATION_CRC32_BYTES);
  bytesBeforeChecksum.copy(record, 0);
  record.writeUInt32BE(crc32(bytesBeforeChecksum), bytesBeforeChecksum.byteLength);

  return record;
}

export function decodeOperationRecord(bytesBeforeChecksum: Buffer, checksum: Buffer): OperationRecord {
  const expectedChecksum = checksum.readUInt32BE(0);
  const actualChecksum = crc32(bytesBeforeChecksum);

  if (actualChecksum !== expectedChecksum) {
    throw new Error("Invalid operation record: CRC32 checksum mismatch.");
  }

  const payloadLength = bytesBeforeChecksum.readUInt32BE(OPERATION_IDENTIFIER_BYTES);
  const payloadStart = OPERATION_HEADER_BYTES;
  const payloadEnd = payloadStart + payloadLength;

  return {
    identifier: Buffer.from(bytesBeforeChecksum.subarray(0, OPERATION_IDENTIFIER_BYTES)),
    payload: Buffer.from(bytesBeforeChecksum.subarray(payloadStart, payloadEnd))
  };
}

export function assertOperationIdentifier(identifier: Buffer): void {
  if (identifier.byteLength !== OPERATION_IDENTIFIER_BYTES) {
    throw new Error(`Operation identifier must be exactly ${OPERATION_IDENTIFIER_BYTES} bytes.`);
  }
}

/**
 * Parse a single operation record from an already-loaded in-memory buffer.
 *
 * `buffer` is the bulk content of the file starting at `FILE_HEADER_BYTES`.
 * `relativeOffset` is `absoluteFileOffset - FILE_HEADER_BYTES`.
 *
 * Uses `subarray` throughout to avoid copying bytes; the returned `identifier`
 * and `payload` are independent copies (via `Buffer.from`) so they remain
 * valid after the bulk buffer is discarded.
 */
export function readOperationFromBuffer(
  buffer: Buffer,
  relativeOffset: number
): OperationRecord & { byteLength: number } {
  if (relativeOffset + OPERATION_HEADER_BYTES > buffer.length) {
    throw new Error("Invalid operation record: unexpected end of buffer.");
  }

  const payloadLength = buffer.readUInt32BE(relativeOffset + OPERATION_IDENTIFIER_BYTES);
  const totalLength = OPERATION_HEADER_BYTES + payloadLength + OPERATION_CRC32_BYTES;

  if (relativeOffset + totalLength > buffer.length) {
    throw new Error("Invalid operation record: unexpected end of buffer.");
  }

  const bytesBeforeChecksum = buffer.subarray(
    relativeOffset,
    relativeOffset + OPERATION_HEADER_BYTES + payloadLength
  );
  const checksum = buffer.subarray(
    relativeOffset + OPERATION_HEADER_BYTES + payloadLength,
    relativeOffset + totalLength
  );

  const operation = decodeOperationRecord(bytesBeforeChecksum, checksum);

  return { ...operation, byteLength: totalLength };
}
