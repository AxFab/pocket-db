import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pocketDb } from "../../src/index.js";
import type { Adapter, BenchDocument, StoredDocument } from "./adapter.js";
import type { Collection, Database, OpenOptions } from "../../src/api/types.js";

/**
 * Byte budget used when the adapter mode contains the `cache` token. Sized
 * generously so the entire benchmark dataset (plus documents inserted during
 * the run) stays resident, isolating the cost/benefit of the hot-document cache
 * from eviction churn.
 */
const CACHE_BYTES = 64 * 1024 * 1024;

export class PocketDbAdapter implements Adapter {
  readonly name // = "pocket-db";

  private tempDir = "";
  private db: Database | null = null;
  private col: Collection | null = null;
  private readonly useCache: boolean;

  constructor (mode:string) {
    mode = mode || "relaxed"
    this.name = `pocket-db (${mode})`
    this.useCache = mode.includes("cache")
  }

  setup(initialDocs: BenchDocument[]): string[] {
    this.tempDir = mkdtempSync(join(tmpdir(), "pdb-bench-"));
    const opts:OpenOptions = { path: join(this.tempDir, "bench.pdb") };
    if (this.name.includes('strict'))
      opts.durability = 'strict'
    else if (this.name.includes('relaxed'))
      opts.durability = 'relaxed'
    if (this.name.includes('json'))
      opts.serialization = 'json'
    else if (this.name.includes('bson'))
      opts.serialization = 'bson'
    else if (this.name.includes('amf3'))
      opts.serialization = 'amf3'
    this.db = pocketDb(opts);
    this.col = this.db.collection("docs");
    this.col.createIndex("role", { type: "string" });

    // Enable the hot-document cache before the initial load so inserts prime it.
    if (this.useCache)
      this.col.enableCache(CACHE_BYTES);

    const { insertedIds } = this.col.insertMany(initialDocs as unknown as Record<string, unknown>[]);
    return insertedIds;
  }

  teardown(): void {
    this.db?.close();
    this.db = null;
    this.col = null;
    if (this.tempDir) {
      rmSync(this.tempDir, { recursive: true, force: true });
      this.tempDir = "";
    }
  }

  insertOne(doc: BenchDocument): string {
    return this.col!.insertOne(doc as unknown as Record<string, unknown>).insertedId;
  }

  insertMany(docs: BenchDocument[]): void {
    this.col!.insertMany(docs as unknown as Record<string, unknown>[]);
  }

  findById(id: string): StoredDocument | null {
    return this.col!.findOne({ _id: id }) as unknown as StoredDocument | null;
  }

  findAll(): StoredDocument[] {
    return this.col!.find({}).toArray() as unknown as StoredDocument[];
  }

  findByName(name: string): StoredDocument[] {
    return this.col!.find({ name }).toArray() as unknown as StoredDocument[];
  }

  findByRole(role: string): StoredDocument[] {
    return this.col!.find({ role }).toArray() as unknown as StoredDocument[];
  }

  // Unindexed $regex scan — full collection read + regex residual filter.
  findByNameRegex(pattern: string): StoredDocument[] {
    return this.col!.find({ name: { $regex: pattern } }).toArray() as unknown as StoredDocument[];
  }

  updateOne(id: string, score: number): void {
    this.col!.updateOne(id, { $set: { score } });
  }

  deleteOne(id: string): void {
    this.col!.deleteOne(id);
  }

  countAll(): number {
    // Fast path: candidates.length, no document reads.
    return this.col!.countDocuments();
  }

  sortByScore(): StoredDocument[] {
    return this.col!.find({}).sort({ score: -1 }).toArray() as unknown as StoredDocument[];
  }
}
