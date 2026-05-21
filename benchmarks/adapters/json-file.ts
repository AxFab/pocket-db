import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateId } from "../data.js";
import type { Adapter, BenchDocument, StoredDocument } from "./adapter.js";

/**
 * JSON-file adapter.
 *
 * Represents the naive "persist-on-write" approach common in small tools:
 * all data lives in a `Map` in memory, and the entire collection is serialised
 * to a single JSON file on every mutation. Reads are served from the in-memory
 * Map without touching disk.
 *
 * This models the pattern used by tools like VS Code's JSON settings store or
 * many CLI config files. It is intentionally simple — no index, no schema —
 * which makes it the baseline that pocket-db's append-only design improves upon
 * for write-heavy workloads.
 */
export class JsonFileAdapter implements Adapter {
  readonly name = "json-file";

  private tempDir = "";
  private filePath = "";
  private data = new Map<string, StoredDocument>();

  setup(initialDocs: BenchDocument[]): string[] {
    this.tempDir = mkdtempSync(join(tmpdir(), "json-bench-"));
    this.filePath = join(this.tempDir, "bench.json");
    this.data = new Map();

    const ids: string[] = [];
    for (const doc of initialDocs) {
      const id = generateId();
      this.data.set(id, { ...doc, _id: id });
      ids.push(id);
    }
    this.flush();
    return ids;
  }

  teardown(): void {
    this.data.clear();
    if (this.tempDir) {
      rmSync(this.tempDir, { recursive: true, force: true });
      this.tempDir = "";
    }
  }

  insertOne(doc: BenchDocument): string {
    const id = generateId();
    this.data.set(id, { ...doc, _id: id });
    this.flush();
    return id;
  }

  insertMany(docs: BenchDocument[]): void {
    for (const doc of docs) {
      const id = generateId();
      this.data.set(id, { ...doc, _id: id });
    }
    this.flush();
  }

  findById(id: string): StoredDocument | null {
    return this.data.get(id) ?? null;
  }

  findAll(): StoredDocument[] {
    return Array.from(this.data.values());
  }

  findByName(name: string): StoredDocument[] {
    return Array.from(this.data.values()).filter((doc) => doc.name === name);
  }

  // No index — falls back to a full in-memory scan.
  findByRole(role: string): StoredDocument[] {
    return Array.from(this.data.values()).filter((doc) => doc.role === role);
  }

  updateOne(id: string, score: number): void {
    const doc = this.data.get(id);
    if (doc) {
      this.data.set(id, { ...doc, score });
      this.flush();
    }
  }

  deleteOne(id: string): void {
    if (this.data.delete(id)) {
      this.flush();
    }
  }

  countAll(): number {
    return this.data.size;
  }

  sortByScore(): StoredDocument[] {
    return Array.from(this.data.values()).sort((a, b) => b.score - a.score);
  }

  private flush(): void {
    writeFileSync(this.filePath, JSON.stringify(Array.from(this.data.values())));
  }
}
