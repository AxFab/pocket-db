import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

/**
 * Single-process file lock for Pocket DB.
 *
 * Creates a `<dbPath>.lock` file on acquire and removes it on release.
 * The lock file holds the PID of the owner process so that stale locks
 * (left behind by a crash) can be detected and reclaimed automatically.
 *
 * Acquiring a lock held by a live process throws an error with a clear
 * message. Acquiring a lock held by a dead process silently reclaims it.
 */
export class FileLock {
  private constructor(private readonly lockPath: string) {}

  static acquire(dbPath: string): FileLock {
    const lock = new FileLock(`${dbPath}.lock`);
    lock.tryAcquire();
    return lock;
  }

  release(): void {
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Ignore if the file was already removed (e.g. by a forced cleanup).
    }
  }

  private tryAcquire(): void {
    // Attempt an exclusive create — succeeds only if the file does not exist.
    try {
      const fd = openSync(this.lockPath, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }

    // Lock file already exists — determine whether the owner is still alive.
    let holdingPid: number | null = null;

    try {
      holdingPid = parseInt(readFileSync(this.lockPath, "utf8").trim(), 10);
    } catch {
      // Cannot read the lock file; treat as stale.
    }

    if (holdingPid !== null && !isNaN(holdingPid) && isProcessAlive(holdingPid)) {
      throw new Error(
        `Cannot open database: already in use by process ${holdingPid}. ` +
        `Close the other connection first, or delete "${this.lockPath}" ` +
        `if that process has crashed.`
      );
    }

    // Stale lock — remove it and retry.
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Another process may have cleaned it up concurrently; proceed.
    }

    this.tryAcquire();
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks for process existence without sending a real signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
