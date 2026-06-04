import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SqliteDatabase from "better-sqlite3";
import type { Database, Statement } from "better-sqlite3";
import { generateId } from "../data.js";
import type { Adapter, BenchDocument, StoredDocument } from "./adapter.js";

/**
 * SQLite adapter.
 *
 * Documents are stored as JSON blobs in a TEXT column. Two additional columns
 * (`role`, `age`) are extracted at insert time and indexed with a B-tree index
 * so that `findByRole` can use the index rather than a full scan.
 *
 * All statements are compiled once at setup time and reused, avoiding the
 * per-call parsing overhead that would unfairly penalise SQLite.
 *
 * In file-mode compare to memory mode, the only
 * difference is that the database lives on disk in a temporary directory.
 * This is the most direct apples-to-apples comparison with pocket-db.
 */
export class SqliteAdapter implements Adapter {
  readonly name // = "sqlite (file)";

  private tempDir = "";
  private db: Database | null = null;
  private stmtInsert!: Statement;
  private stmtFindById!: Statement;
  private stmtFindAll!: Statement;
  private stmtFindByName!: Statement;
  private stmtFindByRole!: Statement;
  private stmtUpdate!: Statement;
  private stmtDelete!: Statement;
  private stmtCount!: Statement;
  private stmtSortByScore!: Statement;

  constructor (mode:string) {
    mode = mode ?? 'file'
    this.name = `sqlite (${mode})`
  }

  setup(initialDocs: BenchDocument[]): string[] {
    if (this.name === 'sqlite (file)') {
      this.tempDir = mkdtempSync(join(tmpdir(), "sqlite-bench-"));
      this.db = new SqliteDatabase(join(this.tempDir, "bench.db"));
    } else {
      this.db = new SqliteDatabase(":memory:");
    }
    this.createSchema();
    this.prepareStatements();
    return this.bulkInsert(initialDocs);
  }

  teardown(): void {
    this.db?.close();
    this.db = null;
    if (this.tempDir) {
      rmSync(this.tempDir, { recursive: true, force: true });
      this.tempDir = "";
    }
  }

  insertOne(doc: BenchDocument): string {
    const id = generateId();
    this.stmtInsert.run(id, JSON.stringify({ ...doc, _id: id }), doc.role, doc.age, doc.score);
    return id;
  }

  insertMany(docs: BenchDocument[]): void {
    const insert = this.db!.transaction((batch: BenchDocument[]) => {
      for (const doc of batch) {
        const id = generateId();
        this.stmtInsert.run(id, JSON.stringify({ ...doc, _id: id }), doc.role, doc.age, doc.score);
      }
    });
    insert(docs);
  }

  findById(id: string): StoredDocument | null {
    const row = this.stmtFindById.get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as StoredDocument : null;
  }

  findAll(): StoredDocument[] {
    return (this.stmtFindAll.all() as { data: string }[]).map((r) => JSON.parse(r.data) as StoredDocument);
  }

  findByName(name: string): StoredDocument[] {
    return (this.stmtFindByName.all(name) as { data: string }[]).map((r) => JSON.parse(r.data) as StoredDocument);
  }

  findByRole(role: string): StoredDocument[] {
    return (this.stmtFindByRole.all(role) as { data: string }[]).map((r) => JSON.parse(r.data) as StoredDocument);
  }

  updateOne(id: string, score: number): void {
    this.stmtUpdate.run(score, score, id);
  }

  deleteOne(id: string): void {
    this.stmtDelete.run(id);
  }

  countAll(): number {
    return (this.stmtCount.get() as { n: number }).n;
  }

  sortByScore(): StoredDocument[] {
    return (this.stmtSortByScore.all() as { data: string }[]).map((r) => JSON.parse(r.data) as StoredDocument);
  }

  private createSchema(): void {
    this.db!.exec(`
      CREATE TABLE documents (
        id    TEXT PRIMARY KEY,
        data  TEXT NOT NULL,
        role  TEXT,
        age   REAL,
        score REAL
      );
      CREATE INDEX idx_role  ON documents(role);
      CREATE INDEX idx_age   ON documents(age);
      CREATE INDEX idx_score ON documents(score);
    `);
  }

  private prepareStatements(): void {
    this.stmtInsert      = this.db!.prepare("INSERT INTO documents (id, data, role, age, score) VALUES (?, ?, ?, ?, ?)");
    this.stmtFindById    = this.db!.prepare("SELECT data FROM documents WHERE id = ?");
    this.stmtFindAll     = this.db!.prepare("SELECT data FROM documents");
    // Unindexed scan via json_extract — equivalent to pocket-db's full-collection scan.
    this.stmtFindByName  = this.db!.prepare("SELECT data FROM documents WHERE json_extract(data, '$.name') = ?");
    // Indexed lookup via the extracted role column.
    this.stmtFindByRole  = this.db!.prepare("SELECT data FROM documents WHERE role = ?");
    this.stmtUpdate      = this.db!.prepare(
      "UPDATE documents SET data = json_set(data, '$.score', ?), score = ? WHERE id = ?"
    );
    this.stmtDelete      = this.db!.prepare("DELETE FROM documents WHERE id = ?");
    this.stmtCount       = this.db!.prepare("SELECT COUNT(*) AS n FROM documents");
    // Uses the idx_score B-tree index for an efficient sorted scan.
    this.stmtSortByScore = this.db!.prepare("SELECT data FROM documents ORDER BY score DESC");
  }

  private bulkInsert(docs: BenchDocument[]): string[] {
    const ids: string[] = [];
    const insert = this.db!.transaction((batch: BenchDocument[]) => {
      for (const doc of batch) {
        const id = generateId();
        this.stmtInsert.run(id, JSON.stringify({ ...doc, _id: id }), doc.role, doc.age, doc.score);
        ids.push(id);
      }
    });
    insert(docs);
    return ids;
  }
}
