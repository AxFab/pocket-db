import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/index.js";

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
    const db = open({ path });

    assert.ok(existsSync(`${path}.lock`), "lock file should exist while the database is open");

    db.close();
  });

  it("removes the lock file when the database is closed", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    db.close();

    assert.ok(!existsSync(`${path}.lock`), "lock file should be removed after close()");
  });

  it("throws when a second open() call targets the same file while the first is still open", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const first = open({ path });

    try {
      assert.throws(
        () => open({ path }),
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
    const first = open({ path });
    first.close();

    const second = open({ path });
    second.close();

    assert.ok(!existsSync(`${path}.lock`));
  });

  it("reclaims a stale lock whose PID is unreadable (treated as dead process)", () => {
    const path = join(createTempDirectory(), "test.pdb");

    // Plant a lock file with a garbage PID — parseInt will return NaN,
    // which the lock implementation treats as a stale (dead) holder.
    writeFileSync(`${path}.lock`, "not-a-pid");

    const db = open({ path });
    db.close();

    assert.ok(!existsSync(`${path}.lock`));
  });
});
