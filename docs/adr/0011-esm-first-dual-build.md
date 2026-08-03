# ADR 0011: ESM-First Source with a Generated CommonJS Build

## Status

Accepted (V1).

## Context

Pocket DB is published as a library (`@axfab/pocket-db` on npm) intended to
be consumed by a range of Node.js projects — desktop apps, CLI tools,
Electron apps, local servers, plugins. As of V1's development, the Node.js
ecosystem is mid-transition between CommonJS (`require`) and ES Modules
(`import`): plenty of consuming projects are `"type": "commonjs"` and expect
`require("@axfab/pocket-db")` to work, while modern projects and tooling
increasingly default to or prefer native ESM.

A library has to pick one of: publish CJS only (simple, but blocks native-ESM
consumers from clean static imports and tree-shaking), publish ESM only
(modern, but breaks for any consumer still on CommonJS), or publish both from
one source tree.

## Decision

Write the source as ESM-only TypeScript, and generate a CommonJS build as a
second compilation pass over the same source — not a hand-maintained parallel
implementation:

- `package.json` declares `"type": "module"` and uses `tsconfig.json` with
  `"module": "NodeNext"`. All internal imports use explicit `.js` extensions
  even though the source files are `.ts` — required by `NodeNext` module
  resolution for ESM correctness, and enforced project-wide rather than only
  where it happens to matter.
- The build (`npm run build`) runs two separate `tsc` invocations against two
  `tsconfig` files: `tsconfig.json` (ESM, emits to `dist/`) and
  `tsconfig.cjs.json` (CJS, emits to `dist/cjs/`). No source code differs
  between the two outputs — only the compiler's module target changes. A
  `dist/cjs/package.json` containing `{"type": "commonjs"}` is written
  alongside the CJS output so Node's module resolution treats that
  subdirectory correctly regardless of the package-level `"type": "module"`.
- `package.json`'s `exports` map exposes both: `"import"` resolves to
  `dist/index.js` (ESM), `"require"` resolves to `dist/cjs/index.js` (CJS),
  and `"types"` points at the ESM `.d.ts` output for both. `main` and
  `module` fields are also set for older tooling that doesn't read
  `exports`.
- `outDir: "dist"` with only `src/**/*` included means `tsc` infers
  `rootDir: "src"`, keeping the build flat (`dist/index.js`, not
  `dist/src/index.js`) — a deliberate configuration choice to keep the
  published package's directory structure predictable.
- Tests and benchmarks are never compiled; they run straight from `.ts`
  source via `node --import tsx --test`, so the dual-build concern is
  entirely isolated to what actually gets published.

## Consequences

- Consumers get a native experience regardless of their own module system —
  `import { open } from "@axfab/pocket-db"` and
  `const { open } = require("@axfab/pocket-db")` both work, resolved via
  `exports` conditions rather than a runtime shim.
- There is exactly one source of truth for the implementation (`src/`); the
  CJS output is mechanically derived, so there is no risk of the two builds
  drifting into different behavior — a class of bug that a hand-maintained
  parallel CJS source tree would risk.
- The build step is doubled in wall-clock cost (two full `tsc` passes) and
  produces two copies of compiled output in `dist/`, increasing package
  size somewhat — an accepted tradeoff for compatibility breadth.
- Because the source itself is ESM-only (`NodeNext` resolution, `.js`
  import extensions required even in `.ts` files), contributors must follow
  ESM import conventions throughout `src/` even though the published
  package also serves CJS consumers — the CJS build is purely an output
  transformation, never a second way of writing source.
- `engines.node: ">=18"` and `target: "ES2022"` reflect a decision to target
  a reasonably modern Node baseline rather than maximizing backward
  compatibility, consistent with an embedded/library-for-modern-Node-apps
  positioning rather than legacy-runtime support.

## Alternatives Considered

- **Publish ESM only** — rejected: would break for any consumer still on
  CommonJS, a meaningful fraction of the Node ecosystem at the time of this
  decision, and Pocket DB's target use cases (CLI tools, plugins, desktop
  apps) skew toward projects that may not have migrated to ESM yet.
- **Publish CJS only** — rejected: forces even ESM-native consumers through
  the CJS interop shim (`require` inside `import`), losing static analysis
  benefits and going against the direction the ecosystem and Node's own
  tooling are moving.
- **Hand-maintain separate ESM and CJS source trees** — rejected outright:
  guarantees behavioral drift over time as one tree gets a fix or feature
  the other doesn't, for zero benefit over generating one from the other
  since the language-level differences between the two outputs are
  entirely mechanical (import/export syntax and file extensions).
- **A bundler-based single-file dual output** (e.g. tsup, rollup) instead of
  two raw `tsc` passes — not adopted: `tsc` alone is sufficient for a
  library with no bundling needs (no code-splitting, no minification
  desired for a Node library), and avoids adding a bundler as a build
  dependency when the standard compiler already produces correct output for
  both targets.
