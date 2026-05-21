import { randomBytes } from "node:crypto";
import type { BenchDocument } from "./adapters/adapter.js";

const NAMES = ["Ada", "Grace", "Margaret", "Hedy", "Katherine", "Dorothy", "Radia", "Barbara"];
const ROLES = ["admin", "editor", "reader"] as const;

/**
 * Generate a deterministic document for a given index.
 * The role cycles across three values so an indexed query returns ~1/3 of docs.
 */
export function generateDoc(index: number): BenchDocument {
  return {
    name: NAMES[index % NAMES.length],
    role: ROLES[index % ROLES.length],
    age: 20 + (index % 60),
    score: (index * 137) % 1000,
    active: index % 3 !== 0
  };
}

/**
 * Generate N deterministic documents.
 */
export function generateDocs(n: number): BenchDocument[] {
  return Array.from({ length: n }, (_, i) => generateDoc(i));
}

/**
 * Generate a 24-character lowercase hex id, matching pocket-db's format.
 * Used by adapters that manage their own id generation (SQLite, JSON-file).
 */
export function generateId(): string {
  return randomBytes(12).toString("hex");
}
