import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pocketDb } from "../src/index.js";
import { FILE_HEADER_BYTES } from "../src/storage/constants.js";

const tempDirectories: string[] = [];

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pocket-db-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("file lock", () => {
  it("creates a lock file next to the database when opened", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });

    assert.ok(existsSync(`${path}.lock`), "lock file should exist while the database is open");

    db.close();
  });

  it("removes the lock file when the database is closed", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    db.close();

    assert.ok(!existsSync(`${path}.lock`), "lock file should be removed after close()");
  });

  it("throws when a second pocketDb() call targets the same file while the first is still open", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const first = pocketDb({ path });

    try {
      assert.throws(
        () => pocketDb({ path }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("already in use"),
            `Expected "already in use" in error message, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      first.close();
    }
  });

  it("allows reopening after the first handle is closed", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const first = pocketDb({ path });
    first.close();

    const second = pocketDb({ path });
    second.close();

    assert.ok(!existsSync(`${path}.lock`));
  });

  it("reclaims a stale lock whose PID is unreadable (treated as dead process)", () => {
    const path = join(createTempDirectory(), "test.pdb");

    // Plant a lock file with a garbage PID — parseInt will return NaN,
    // which the lock implementation treats as a stale (dead) holder.
    writeFileSync(`${path}.lock`, "not-a-pid");

    const db = pocketDb({ path });
    db.close();

    assert.ok(!existsSync(`${path}.lock`));
  });

  it("releases the lock file when open() throws during database initialisation", () => {
    const path = join(createTempDirectory(), "test.pdb");

    // Create a valid database with one document so the file has operation records.
    const db = pocketDb({ path });
    db.collection("items").insertOne({ x: 1 });
    db.close();

    // Corrupt the first byte of the first operation record (right after the
    // 12-byte file header). This flips one nibble of the identifier, causing a
    // CRC32 mismatch that makes loadCollections() throw during open().
    const raw = readFileSync(path);
    raw[FILE_HEADER_BYTES] ^= 0xff;
    writeFileSync(path, raw);

    // open() must throw (CRC mismatch) and must not leave the lock on disk.
    assert.throws(() => pocketDb({ path }));
    assert.ok(
      !existsSync(`${path}.lock`),
      "lock file must be removed even when open() throws during initialisation"
    );
  });
});
