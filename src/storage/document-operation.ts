import { alignTo4Bytes } from "./padding.js";
import { assertCollectionId } from "./collection-operation.js";
import { DOCUMENT_IDENTIFIER_BYTES } from "./constants.js";
import type { DocumentEncoder } from "./encoding/document-encoder.js";
import { decodeU29, encodeU29 } from "./u29.js";

export interface PutDocumentOperation {
  collectionId: Buffer;
  documentId: Buffer;
  document: Record<string, unknown>;
}

export interface DecodedPutDocumentOperation {
  collectionId: Buffer;
  documentId: Buffer;
  documentIdHex: string;
  document: Record<string, unknown>;
}

export interface DeleteDocumentOperation {
  collectionId: Buffer;
  documentId: Buffer;
}

export interface DecodedDeleteDocumentOperation {
  collectionId: Buffer;
  documentId: Buffer;
  documentIdHex: string;
}

export function encodePutDocumentPayload(operation: PutDocumentOperation, encoder: DocumentEncoder): Buffer {
  assertCollectionId(operation.collectionId);
  assertDocumentId(operation.documentId);

  const documentBytes = encoder.encode(operation.document);
  const encodedDocumentLength = encodeU29(documentBytes.byteLength);
  const unalignedLength =
    operation.collectionId.byteLength +
    operation.documentId.byteLength +
    encodedDocumentLength.byteLength +
    documentBytes.byteLength;
  const payload = Buffer.alloc(alignTo4Bytes(unalignedLength));

  operation.collectionId.copy(payload, 0);
  operation.documentId.copy(payload, operation.collectionId.byteLength);
  encodedDocumentLength.copy(payload, operation.collectionId.byteLength + operation.documentId.byteLength);
  documentBytes.copy(
    payload,
    operation.collectionId.byteLength + operation.documentId.byteLength + encodedDocumentLength.byteLength
  );

  return payload;
}

export function decodePutDocumentPayload(payload: Buffer, encoder: DocumentEncoder): DecodedPutDocumentOperation {
  const collectionId = Buffer.from(payload.subarray(0, 4));
  const documentId = Buffer.from(payload.subarray(4, 4 + DOCUMENT_IDENTIFIER_BYTES));
  assertCollectionId(collectionId);
  assertDocumentId(documentId);

  const encodedDocument = decodeU29(payload, 4 + DOCUMENT_IDENTIFIER_BYTES);
  const documentStart = 4 + DOCUMENT_IDENTIFIER_BYTES + encodedDocument.bytesRead;
  const documentEnd = documentStart + encodedDocument.value;

  if (documentEnd > payload.byteLength) {
    throw new Error("Invalid put document operation: document exceeds payload length.");
  }

  const padding = payload.subarray(documentEnd);

  if (!padding.every((byte) => byte === 0)) {
    throw new Error("Invalid put document operation: non-zero padding.");
  }

  return {
    collectionId,
    documentId,
    documentIdHex: documentId.toString("hex"),
    document: encoder.decode(payload.subarray(documentStart, documentEnd))
  };
}

export function encodeDeleteDocumentPayload(operation: DeleteDocumentOperation): Buffer {
  assertCollectionId(operation.collectionId);
  assertDocumentId(operation.documentId);

  const payload = Buffer.alloc(operation.collectionId.byteLength + operation.documentId.byteLength);

  operation.collectionId.copy(payload, 0);
  operation.documentId.copy(payload, operation.collectionId.byteLength);

  return payload;
}

export function decodeDeleteDocumentPayload(payload: Buffer): DecodedDeleteDocumentOperation {
  const expectedLength = 4 + DOCUMENT_IDENTIFIER_BYTES;

  if (payload.byteLength !== expectedLength) {
    throw new Error(`Invalid delete document operation: payload must be ${expectedLength} bytes.`);
  }

  const collectionId = Buffer.from(payload.subarray(0, 4));
  const documentId = Buffer.from(payload.subarray(4, expectedLength));
  assertCollectionId(collectionId);
  assertDocumentId(documentId);

  return {
    collectionId,
    documentId,
    documentIdHex: documentId.toString("hex")
  };
}

export function assertDocumentId(id: Buffer): void {
  if (id.byteLength !== DOCUMENT_IDENTIFIER_BYTES) {
    throw new Error(`Document identifier must be exactly ${DOCUMENT_IDENTIFIER_BYTES} bytes.`);
  }
}
