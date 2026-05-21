import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LowSync } from "lowdb";
import { JSONFileSync } from "lowdb/node";
import { generateId } from "../data.js";
import type { Adapter, BenchDocument, StoredDocument } from "./adapter.js";

/**
 * lowdb adapter (synchronous).
 *
 * lowdb is a small JSON file database for Node.js. All data lives in a plain
 * JSON file; the entire file is rewritten on every mutation. Operations are
 * synchronous via `LowSync` + `JSONFileSync`.
 *
 * There is no built-in query engine or index support — every filter is a
 * linear JavaScript array scan. This makes lowdb the simplest possible
 * file-backed store and a good baseline for read-heavy, low-volume use cases.
 */

/** Shape of the JSON file written by lowdb. */
type DbData = { docs: StoredDocument[] };

export class LowDbAdapter implements Adapter {
  readonly name = "lowdb";

  private tempDir = "";
  private db: LowSync<DbData> | null = null;

  setup(initialDocs: BenchDocument[]): string[] {
    this.tempDir = mkdtempSync(join(tmpdir(), "lowdb-bench-"));
    const filePath = join(this.tempDir, "bench.json");

    const fileAdapter = new JSONFileSync<DbData>(filePath);
    this.db = new LowSync<DbData>(fileAdapter, { docs: [] });
    this.db.read();

    const ids: string[] = [];
    for (const doc of initialDocs) {
      const id = generateId();
      this.db.data.docs.push({ ...doc, _id: id });
      ids.push(id);
    }
    this.db.write();
    return ids;
  }

  teardown(): void {
    this.db = null;
    if (this.tempDir) {
      rmSync(this.tempDir, { recursive: true, force: true });
      this.tempDir = "";
    }
  }

  insertOne(doc: BenchDocument): string {
    const id = generateId();
    this.db!.data.docs.push({ ...doc, _id: id });
    this.db!.write();
    return id;
  }

  insertMany(docs: BenchDocument[]): void {
    for (const doc of docs) {
      const id = generateId();
      this.db!.data.docs.push({ ...doc, _id: id });
    }
    this.db!.write();
  }

  findById(id: string): StoredDocument | null {
    return this.db!.data.docs.find((d) => d._id === id) ?? null;
  }

  findAll(): StoredDocument[] {
    return this.db!.data.docs.slice();
  }

  // No index — full linear scan.
  findByName(name: string): StoredDocument[] {
    return this.db!.data.docs.filter((d) => d.name === name);
  }

  // No index — full linear scan.
  findByRole(role: string): StoredDocument[] {
    return this.db!.data.docs.filter((d) => d.role === role);
  }

  updateOne(id: string, score: number): void {
    const doc = this.db!.data.docs.find((d) => d._id === id);
    if (doc) {
      doc.score = score;
      this.db!.write();
    }
  }

  deleteOne(id: string): void {
    const idx = this.db!.data.docs.findIndex((d) => d._id === id);
    if (idx !== -1) {
      this.db!.data.docs.splice(idx, 1);
      this.db!.write();
    }
  }

  countAll(): number {
    return this.db!.data.docs.length;
  }

  sortByScore(): StoredDocument[] {
    return this.db!.data.docs.slice().sort((a, b) => b.score - a.score);
  }
}
