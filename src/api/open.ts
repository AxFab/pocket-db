import { FileLock } from "../storage/file-lock.js";
import { FileStorage } from "../storage/file-storage.js";
import { PocketDatabase } from "./database.js";
import type { Database, OpenOptions } from "./types.js";

const DEFAULT_DATABASE_PATH = "pocket.db";

export function open(options: OpenOptions = {}): Database {
  const dbPath = options.path ?? DEFAULT_DATABASE_PATH;
  const lock = FileLock.acquire(dbPath);
  const storage = FileStorage.open(dbPath);
  return new PocketDatabase(storage, lock);
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
