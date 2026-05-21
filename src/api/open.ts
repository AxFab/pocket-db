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
