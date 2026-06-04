/**
 * Abstraction over the document serialization format used by the storage layer.
 *
 * Implementations must be stateless and deterministic: encoding the same
 * document twice must produce the same bytes, and decoding those bytes must
 * reproduce a value that is deep-equal to the original.
 *
 * The format byte stored in the file header (`SERIALIZATION_FORMAT` field)
 * selects which implementation is used at open time:
 *   'j' (0x6a) → JsonDocumentEncoder
 *   'b' (0x62) → BsonDocumentEncoder
 */
export interface DocumentEncoder {
  /**
   * Serializes a document to a raw byte buffer.
   *
   * @param document - The plain-object document to encode.
   * @returns A Buffer containing the encoded document bytes.
   */
  encode(document: Record<string, unknown>): Buffer;

  /**
   * Deserializes a raw byte buffer back into a plain-object document.
   *
   * @param bytes - The encoded document bytes (exactly as returned by `encode`).
   * @returns The reconstructed document.
   */
  decode(bytes: Buffer): Record<string, unknown>;
}
