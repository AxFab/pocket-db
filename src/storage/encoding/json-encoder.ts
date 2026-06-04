import type { DocumentEncoder } from "./document-encoder.js";

/**
 * JSON-based document encoder.
 *
 * Serializes documents using `JSON.stringify` / `JSON.parse` with UTF-8
 * encoding. This is the default format (file header byte `'j'`).
 *
 * Limitations (inherited from JSON):
 *   - `undefined` values are dropped on encode.
 *   - `NaN` and `±Infinity` are serialized as `null`.
 *   - Circular references throw at encode time.
 */
export class JsonDocumentEncoder implements DocumentEncoder {
  encode(document: Record<string, unknown>): Buffer {
    return Buffer.from(JSON.stringify(document), "utf8");
  }

  decode(bytes: Buffer): Record<string, unknown> {
    return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  }
}

/** Shared singleton — JSON encoder is stateless, no need to instantiate per-call. */
export const jsonEncoder: DocumentEncoder = new JsonDocumentEncoder();
