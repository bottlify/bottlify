# `@bottlify/core` — module documentation

This is the durable, git-tracked documentation for the core package's module system: interface,
configuration, and current limitations. `roadmap/` (the phase-by-phase plan) is intentionally kept
out of git as local working notes — this file is what survives a fresh clone, and it's updated as
each phase lands rather than written once and left stale.

See [`infrastructure.md`](./infrastructure.md) for how the module graph below maps onto actual
directories inside `modules/core/src/layers/` (per-DLL/per-backend layout, naming conventions,
cross-cutting DLL splits).

## Interface

A module is a plain object matching this shape (`modules/core/src/system/contract.js`):

```js
/**
 * @typedef {Object} BottlifyModule
 * @property {string} name
 * @property {string} version
 * @property {readonly string[]} requires   // interfaces consumed — never a concrete implementation
 * @property {(config, host: ScopedModuleHost) => Promise<ModuleApi>} create
 * @property {() => ModuleDiagnostics} diagnostics   // required for every module, no exceptions
 * @property {() => Promise<void>} dispose
 */
```

`createBottlify(config)` (`src/core.js`) is the only entry point: it builds a `ModuleRegistry` from
the package's default module list (`src/layers/index.js`), resolves a build plan from `config`, then
creates each module in topological order, handing each one a `ScopedModuleHost`
(`src/system/host.js`) that only exposes the APIs it declared in `requires`. The returned
`CoreInstance` exposes `api(name)`, `diagnostics()` (one entry per module), and `dispose()` (reverse
creation order).

There are no singletons and no ambient global state between modules — a module that wants another
module's API must declare it in `requires` and fetch it through the host it's given in `create`.
This is enforced at two levels: `host.requireApi` throws if the name isn't in the module's own
`requires`, and `scripts/check-boundaries.mjs` statically rejects any source file that imports
another layer's internals directly instead of going through its declared dependency.

## Configuration

`createBottlify` takes `{ [moduleName]: boolean | object | undefined }` (`src/system/config.js`):

| value                | meaning                                                              |
|-----------------------|-----------------------------------------------------------------------|
| `undefined` / `true`  | module enabled, default configuration                                 |
| `false` / `null`      | module disabled — dropped entirely, *unless* something else needs it  |
| an object             | module enabled with that configuration (validated by the module)      |
| anything else         | configuration error, thrown before any module is created              |

A disabled module that another active module `requires` is not silently omitted: it's installed as
a stub (see below) so the interface stays bound and the requiring module never has to special-case
"my dependency doesn't exist". An unknown module name anywhere in the configuration is an error.

## Current limitations (Phase 0)

Every layer — `cpu`, `memory`, `kernel`, `bridge`, `loader`, `log`, `filesystem`, `win32`,
`graphics`, `audio`, `input` — is a stub (`src/system/stub.js`): calling any method on it throws
`NOT_IMPLEMENTED`. `diagnostics()` reports `status: "stub"` for all of them. This is intentional and
matches the Phase 0 scope: no x86 instruction has executed, no PE has been parsed, nothing has touched
`vendor/v86` as an emulator (it's built and vendored, not yet run). Implementing a layer means
replacing its `module.js`/`api.js` behind the same `name`/`requires` contract — the registry, host
scoping, and boundary checker do not change.

The only concrete engine dependency wired in is the vendored v86 submodule
(`modules/core/vendor/v86`, pinned by commit) — reachable, by construction (`check:boundaries`),
only from `src/layers/cpu/`.

## Toolchain gotchas found during Phase 0 review

Kept here because they're generic enough to bite other npm-workspaces + `tsc --checkJs` projects,
not just this one:

- **A transitive devDependency can break `tsc --checkJs` on unrelated files.** `@types/node`'s
  `process.d.ts` contains `typeof import("punycode")` (typing `process.getBuiltinModule`). Its own
  ambient `declare module "punycode"` only applies when no *real* `punycode` package resolves on
  disk — so the moment any devDependency pulls one in for real (here: `eslint` → `ajv` → `uri-js` →
  `punycode`), TypeScript resolves to that real, untyped, legacy file instead, and with
  `allowJs`+`checkJs` on, fully type-checks it — producing dozens of unrelated errors with no
  connection to project code. Fixed with a `compilerOptions.paths` remap
  (`modules/core/jsconfig.json` → `modules/core/types/punycode.d.ts`) that redirects the bare
  specifier to a one-line ambient stub before real module resolution ever runs. `skipLibCheck`
  does **not** help here — the offending file is a `.js`, not a `.d.ts`.
- **A pinned Docker build image needs the target project's full toolchain, not just its primary
  language.** The vendored v86's own `Makefile` needs, beyond `rustc`: Node (for
  `gen/generate_{jit,interpreter,analyzer}.js`, which must run before `cargo` ever sees the
  generated `.rs` files), a JRE + `wget` (Closure Compiler, self-fetched by the Makefile's own
  rule), `clang` targeting `wasm32` (two C objects compiled with `--target=wasm32`), `python3`
  (`tools/rust-lld-wrapper`), and the `wasm32-unknown-unknown` Rust target added via `rustup`. A
  Dockerfile built from "it's a Rust project, install Rust" alone silently fails the very first time
  the reproducibility gate actually runs — read the target's build system's own requirements, not
  just its primary language, before writing a build image for it.
- **`eslint`'s flat config `no-undef` and `tsc --checkJs` overlap and can conflict.** Code here runs
  across three different global environments (Node scripts, a Web Worker, a browser page) with no
  single ESLint `languageOptions.globals` set describing all three correctly. Rather than
  duplicating per-file environment config that `tsc` already derives correctly from each file's
  actual runtime, `no-undef` is turned off in `eslint.config.mjs` and left to typecheck.
