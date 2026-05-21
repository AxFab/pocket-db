export const MAGIC_HEADER = "pocketdb";
export const MAGIC_HEADER_BYTES = Buffer.from(MAGIC_HEADER, "utf8");

// Format header — 4 bytes immediately after the magic, mandatory.
// byte 0: file format major version (breaking changes)
// byte 1: file format minor version (backward-compatible additions)
// byte 2: serialization format ASCII char ('j' = JSON)
// byte 3: serialization format version
export const FORMAT_HEADER_BYTES = 4;
export const FORMAT_MAJOR_VERSION = 0;
export const FORMAT_MINOR_VERSION = 1;
export const SERIALIZATION_FORMAT = "j".charCodeAt(0);
export const SERIALIZATION_VERSION = 0;

// Total file header = magic (8) + format header (4)
export const FILE_HEADER_BYTES = MAGIC_HEADER_BYTES.byteLength + FORMAT_HEADER_BYTES;

export const OPERATION_IDENTIFIER_BYTES = 4;
export const OPERATION_LENGTH_BYTES = 4;
export const OPERATION_CRC32_BYTES = 4;
export const OPERATION_HEADER_BYTES = OPERATION_IDENTIFIER_BYTES + OPERATION_LENGTH_BYTES;
export const NEW_COLLECTION_OPERATION = Buffer.from("ncl1", "utf8");
export const DROP_COLLECTION_OPERATION = Buffer.from("dco1", "utf8");
export const CREATE_INDEX_OPERATION = Buffer.from("idx1", "utf8");
export const DROP_INDEX_OPERATION = Buffer.from("dix1", "utf8");
export const PUT_DOCUMENT_OPERATION = Buffer.from("put1", "utf8");
export const DELETE_DOCUMENT_OPERATION = Buffer.from("del1", "utf8");
export const TRANSACTION_BEGIN_OPERATION = Buffer.from("txnb", "utf8");
export const TRANSACTION_COMMIT_OPERATION = Buffer.from("txnc", "utf8");
export const HOLE_OPERATION = Buffer.from("hol0", "utf8");
export const DOCUMENT_IDENTIFIER_BYTES = 12;
