import { FileLock } from "../storage/file-lock.js";
import { FileStorage } from "../storage/file-storage.js";
import {
  getEncoder,
  SERIALIZATION_FORMAT_AMF3,
  SERIALIZATION_FORMAT_BSON,
  SERIALIZATION_FORMAT_CBOR,
  SERIALIZATION_FORMAT_JSON,
  SERIALIZATION_FORMAT_MSGPACK
} from "../storage/encoding/index.js";
import { PocketDatabase } from "./database.js";
import type { Database, OpenOptions } from "./types.js";

const DEFAULT_DATABASE_PATH = "pocket.db";

export function open(options: OpenOptions = {}): Database {
  const dbPath = options.path ?? DEFAULT_DATABASE_PATH;

  // When creating a new file, respect the caller's serialization preference.
  // When opening an existing file, the format is read from the header and this
  // option is ignored (FileStorage.open handles that path).
  const requestedFormatByte =
    options.serialization === "bson"     ? SERIALIZATION_FORMAT_BSON
    : options.serialization === "amf3"   ? SERIALIZATION_FORMAT_AMF3
    : options.serialization === "cbor"   ? SERIALIZATION_FORMAT_CBOR
    : options.serialization === "msgpack" ? SERIALIZATION_FORMAT_MSGPACK
    : SERIALIZATION_FORMAT_JSON;

  const lock = FileLock.acquire(dbPath);
  const storage = FileStorage.open(dbPath, options.durability ?? "relaxed", requestedFormatByte);
  const encoder = getEncoder(storage.serializationFormat);
  return new PocketDatabase(storage, lock, encoder);
}

/**
 * Convenience alias for `open()` that accepts a path string as the first
 * argument instead of an options object.
 *
 * ```ts
 * import { pocketDb } from "pocket-db";
 * const db = pocketDb("./data.pdb");
 * ```
 *
 * When the first argument is a string it is treated as `options.path`.
 * The optional second argument is the same `OpenOptions` object (without
 * `path`, since it is already provided positionally).
 */
export function pocketDb(path: string, options?: Omit<OpenOptions, "path">): Database;
export function pocketDb(options?: OpenOptions): Database;
export function pocketDb(
  pathOrOptions?: string | OpenOptions,
  options?: Omit<OpenOptions, "path">
): Database {
  if (typeof pathOrOptions === "string") {
    return open({ ...options, path: pathOrOptions });
  }
  return open(pathOrOptions ?? {});
}
