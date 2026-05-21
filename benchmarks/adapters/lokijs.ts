import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Loki from "lokijs";
import type { Collection } from "lokijs";
import { generateId } from "../data.js";
import type { Adapter, BenchDocument, StoredDocument } from "./adapter.js";

// LokiJS is a CommonJS module; use createRequire to load it from an ESM context.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const LokiCtor: typeof Loki = require("lokijs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const LokiFsSyncAdapter = require("lokijs/src/loki-fs-sync-adapter.js");

/**
 * LokiJS internal metadata fields added to every stored document.
 * Not exported by @types/lokijs, so we define the shape inline.
 */
interface LokiMeta {
  $loki: number;
  meta: { created: number; revision: number; updated: number; version: number };
}

/** LokiJS document shape: our fields + LokiJS internal metadata. */
type LokiDoc = StoredDocument & LokiMeta;

/**
 * Strip LokiJS internal fields (`$loki`, `meta`) from a retrieved document.
 */
function stripMeta(doc: LokiDoc): StoredDocument {
  const { $loki: _loki, meta: _meta, ...rest } = doc;
  return rest as StoredDocument;
}

/**
 * LokiJS adapter (synchronous).
 *
 * LokiJS is an in-memory document database with optional file persistence.
 * All core operations (insert, find, update, remove) are synchronous.
 *
 * Persistence is handled by `LokiFsSyncAdapter`, which uses `readFileSync`
 * and `writeFileSync` internally. The Loki instance is configured with
 * `throttledSaves: false` to ensure `saveDatabase()` also fires its callback
 * synchronously before returning.
 *
 * Index strategy:
 * - Unique index on `_id`  → O(1) `findById` via `col.by('_id', id)`.
 * - Binary index on `role` → accelerates `findByRole` queries.
 * - Binary index on `score`→ accelerates `sortByScore` (sorted index scan).
 */
export class LokiJsAdapter implements Adapter {
  readonly name = "lokijs";

  private tempDir = "";
  private db: Loki | null = null;
  private col: Collection<StoredDocument> | null = null;

  setup(initialDocs: BenchDocument[]): string[] {
    this.tempDir = mkdtempSync(join(tmpdir(), "lokijs-bench-"));
    const filePath = join(this.tempDir, "bench.db");

    this.db = new LokiCtor(filePath, {
      adapter: new LokiFsSyncAdapter(),
      throttledSaves: false,
    });

    // loadDatabase callback fires synchronously with LokiFsSyncAdapter.
    this.loadSync();

    this.col = this.db.addCollection<StoredDocument>("docs", {
      indices: ["role", "score"],
    });
    this.col.ensureUniqueIndex("_id");

    const ids: string[] = [];
    for (const doc of initialDocs) {
      const id = generateId();
      this.col.insert({ ...doc, _id: id });
      ids.push(id);
    }
    this.saveSync();
    return ids;
  }

  teardown(): void {
    this.col = null;
    this.db = null;
    if (this.tempDir) {
      rmSync(this.tempDir, { recursive: true, force: true });
      this.tempDir = "";
    }
  }

  insertOne(doc: BenchDocument): string {
    const id = generateId();
    this.col!.insert({ ...doc, _id: id });
    this.saveSync();
    return id;
  }

  insertMany(docs: BenchDocument[]): void {
    for (const doc of docs) {
      const id = generateId();
      this.col!.insert({ ...doc, _id: id });
    }
    this.saveSync();
  }

  findById(id: string): StoredDocument | null {
    // O(1) lookup via the unique index on `_id`.
    const doc = this.col!.by("_id", id) as LokiDoc | undefined;
    return doc ? stripMeta(doc) : null;
  }

  findAll(): StoredDocument[] {
    return (this.col!.find() as LokiDoc[]).map(stripMeta);
  }

  // No index on `name` — falls back to a full collection scan.
  findByName(name: string): StoredDocument[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.col!.find({ name } as any) as LokiDoc[]).map(stripMeta);
  }

  // Uses the binary index on `role` for an accelerated scan.
  findByRole(role: string): StoredDocument[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.col!.find({ role } as any) as LokiDoc[]).map(stripMeta);
  }

  updateOne(id: string, score: number): void {
    const doc = this.col!.by("_id", id) as LokiDoc | undefined;
    if (doc) {
      doc.score = score;
      this.col!.update(doc);
      this.saveSync();
    }
  }

  deleteOne(id: string): void {
    const doc = this.col!.by("_id", id) as LokiDoc | undefined;
    if (doc) {
      this.col!.remove(doc);
      this.saveSync();
    }
  }

  countAll(): number {
    return this.col!.count();
  }

  sortByScore(): StoredDocument[] {
    return (
      this.col!.chain()
        .simplesort("score", { desc: true })
        .data() as LokiDoc[]
    ).map(stripMeta);
  }

  // -------------------------------------------------------------------------
  // Synchronous persistence helpers
  // -------------------------------------------------------------------------

  /**
   * Synchronously load the database. With `LokiFsSyncAdapter`, the callback
   * fires before `loadDatabase` returns, so we can capture any error inline.
   *
   * Note: `LokiFsSyncAdapter` has a known quirk — when the database file does
   * not yet exist it calls the callback twice: first with `null` (new DB) and
   * then again with the `ENOENT` error. We treat `ENOENT` as "no existing
   * database" rather than a hard failure, which matches the intended behaviour.
   */
  private loadSync(): void {
    let loadError: Error | undefined;
    this.db!.loadDatabase({}, (err?: Error) => {
      if (err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
        loadError = err;
      }
    });
    if (loadError) throw loadError;
  }

  /**
   * Synchronously save the database. With `LokiFsSyncAdapter` and
   * `throttledSaves: false`, `saveDatabase` calls its callback before
   * returning, so the write is guaranteed complete when this method exits.
   */
  private saveSync(): void {
    let saveError: Error | undefined;
    this.db!.saveDatabase((err?: Error) => {
      saveError = err ?? undefined;
    });
    if (saveError) throw saveError;
  }
}
