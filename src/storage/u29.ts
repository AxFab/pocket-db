export const U29_MAX_VALUE = 0x1fffffff;

export interface DecodedU29 {
  value: number;
  bytesRead: number;
}

export function encodeU29(value: number): Buffer {
  assertU29(value);

  if (value < 0x80) {
    return Buffer.from([value]);
  }

  if (value < 0x4000) {
    return Buffer.from([
      ((value >> 7) & 0x7f) | 0x80,
      value & 0x7f
    ]);
  }

  if (value < 0x20_0000) {
    return Buffer.from([
      ((value >> 14) & 0x7f) | 0x80,
      ((value >> 7) & 0x7f) | 0x80,
      value & 0x7f
    ]);
  }

  return Buffer.from([
    ((value >> 22) & 0x7f) | 0x80,
    ((value >> 15) & 0x7f) | 0x80,
    ((value >> 8) & 0x7f) | 0x80,
    value & 0xff
  ]);
}

export function decodeU29(bytes: Buffer, offset = 0): DecodedU29 {
  let value = 0;

  for (let index = 0; index < 4; index += 1) {
    const byte = bytes[offset + index];

    if (byte === undefined) {
      throw new Error("Invalid U29 value: unexpected end of buffer.");
    }

    if (index === 3) {
      return {
        value: ((value << 8) | byte) >>> 0,
        bytesRead: 4
      };
    }

    value = (value << 7) | (byte & 0x7f);

    if ((byte & 0x80) === 0) {
      return {
        value,
        bytesRead: index + 1
      };
    }
  }

  throw new Error("Invalid U29 value.");
}

function assertU29(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > U29_MAX_VALUE) {
    throw new Error(`U29 value must be an unsigned 29-bit integer.`);
  }
}
