# Phase 0 — the @bottlify/core module. Description

> The project's first major init. The phase roadmap is `phase-0-skeleton.md`; here is the
> specification of WHAT is being built and what the readiness criteria are. This is the init's
> working document: technical decisions made along the way are written down here, not in chat and
> not in code comments.

## 1. Goal

Once the init is complete, the `@bottlify/core` package exists, and:

1. installs and builds from a clean clone with one command;
2. contains a working module-system skeleton per Master Plan §7's contract;
3. carries a built v86 (js + wasm + BIOS) inside it and depends on nothing external at runtime;
4. is distributed via `dist/`: core itself + all external refs, with fixed checksums;
5. every module entity answers `diagnostics()`.

The init's goal is the module, not emulation. x86 execution starts in Phase 1; here the vendored
v86 must be *built and placed*, but not yet *run as an emulator* even once.

## 2. Package and stack

- `package.json`: name `@bottlify/core`, ESM (`"type": "module"`), zero runtime dependencies —
  everything external is vendored inside the package.
- Code: vanilla ES modules + JSDoc. Types are part of the contract: `tsc --checkJs --noEmit`
  (`checkJs: true` in jsconfig, `strict` at maximum). Where JSDoc can't carry enough weight, a
  `types.d.ts` sits in the layer's folder (types outside the source — this isn't "writing in TS",
  no translated code ships in the product).
- Tests: `node:test` (zero dependencies), placed next to the code — `*.test.js` in the same
  directories; the runner picks them up by the glob pattern `node --test "src/**/*.test.js"`.
  There is no separate `test/` tree.
- Distribution: esbuild bundles `src/core.js` → `dist/core.js` (small, a single file; wasm and BIOS
  are external files alongside it, not inlined).
- Runtime environment: a Web Worker (later: Node for tests). Code is written to run in both;
  browser APIs are isolated behind layers.

## 3. Structure

```
modules/core/
├── package.json
├── jsconfig.json              # checkJs, strict, noEmit
├── vendor/
│   └── v86/                   # git submodule → github.com/mrwayer/v86
├── src/
│   ├── core.js                # facade: config → assemble the module system → { modules, host, diagnostics }
│   ├── system/
│   │   ├── contract.js        # JSDoc typedefs: BottlifyModule, ModuleHost, ModuleDiagnostics
│   │   ├── host.js            # ModuleHost: the single point of contact; no singletons
│   │   ├── registry.js        # module registry, requires checking, creation order
│   │   ├── config.js          # configuration schema validation, default values
│   │   └── stub.js            # layer stub: any method → NOT_IMPLEMENTED
│   └── layers/
│       ├── cpu/               # interface + stub; the v86 vendor is reachable ONLY from here
│       │   ├── module.js      # BottlifyModule: name/version/requires/create/dispose
│       │   ├── api.js         # interface (JSDoc) — the only thing neighbors see
│       │   ├── config.js      # configuration schema + default values
│       │   ├── diagnostics.js # mandatory diagnostics (§7.3)
│       │   ├── internal/      # implementation; NOT importable from outside the layer
│       │   ├── stub.js        # stand-in for a "deaf" build
│       │   └── module.test.js # tests next to the code (same for every layer)
│       ├── memory/
│       ├── kernel/
│       ├── bridge/
│       ├── loader/
│       ├── log/               # dependency modules: log, filesystem —
│       ├── filesystem/        # — graphics, audio, input (Master Plan §6, ✦)
│       ├── graphics/
│       ├── audio/
│       ├── input/
│       └── win32/
├── scripts/
│   ├── build.mjs              # esbuild → dist/
│   ├── build-v86.mjs          # builds the vendor → dist/vendor/
│   ├── verify-reproducibility.mjs
│   └── check-boundaries.mjs   # dependency-cruiser
├── dist/                      # generated; see §5
└── third-party/
    └── v86-license.md         # BSD-2-Clause, copyright notice preserved
```

**Directed dependency graph** (no cycles; a layer's `requires` is a subset of these edges):

```
cpu → ⟨v86⟩                     log → ∅
memory → cpu                    filesystem → log
kernel → cpu, memory, log       loader → cpu, memory, log
bridge → cpu, kernel, log       win32 → bridge, kernel, memory, loader, filesystem, log
graphics/audio/input → win32, bridge, memory      (Phase 5–Phase 7)
```

Rules for resolving disputes: the bottom is machine facts (cpu/memory), the top is promises to the
guest (win32); a lower layer doesn't know about higher ones (the contract lives in `system/`,
layers implement it — Master Plan §3.1); cpu is the sole passage to `vendor/v86`.

## 4. vendor/v86

- **Form:** a git submodule, pinned to commit `d96be77` (the fork's HEAD at init time); branch
  `master`. Updating the fork is a separate task: pull, build, regression test, record the new
  commit in this document.
- **Patches:** on our own branch of the mrwayer/v86 fork. Every change is its own commit with an
  explanation, a "before/after" comparison, and a candidate for upstreaming (Master Plan §2, §8.1:
  MMX→JIT, AOT, hypercalls). There is no such thing as a patch inside vendor's copy without a
  commit in the fork.
- **Build (`build-v86.mjs`):** the vendor's Makefile → `libv86.js`, `v86.wasm`, BIOS
  (`seabios.bin`, `vgabios.bin`) → `dist/vendor/`. Tooling (rustc + wasm32-unknown-unknown) is
  version-pinned.
- **Reproducibility (`verify-reproducibility.mjs`):** a clean container builds from a clean clone;
  the hashes must match `dist/vendor/manifest.json` byte-for-byte. This is the acceptance for
  "the wasm build is reproducible from a clean clone" (Master Plan, Phase 0).
- **License:** BSD-2-Clause; Fabian and contributors' copyright is preserved unchanged, noted in
  the root `THIRD-PARTY-NOTICES.md`.

## 5. dist — the delivery contract

```
dist/
├── core.js                    # ESM bundle entry point for @bottlify/core
├── core.js.map
├── vendor/
│   ├── libv86.js
│   ├── v86.wasm
│   ├── seabios.bin
│   ├── vgabios.bin
│   └── manifest.json          # { "v86": {"commit": "…", "artifacts": {"v86.wasm": "sha256:…", …}, "toolchain": "…" } }
└── checksums.json             # sha256 of every file in dist/, including core.js itself
```

Rules:

1. `dist/` is generated only by scripts; never hand-edited (or the checksums would lie).
2. Everything external lives only under `dist/vendor/`; core.js must not reference anything
   outside its own package (checked in CI).
3. Every core build writes `checksums.json` and checks the vendor is unchanged; a changed vendor
   without a changed submodule commit is a build error.
4. The consumer import is `import { createApp } from "@bottlify/core"`; nothing else pokes out
   of dist.

## 6. Module contract (vanilla JS)

Master Plan §7, in JSDoc form:

```js
/**
 * @template {import("../system/contract.js").ModuleConfigured} [C=object]
 * @template {object} [A=object]
 * @typedef {object} BottlifyModule
 * @property {string} name
 * @property {string} version
 * @property {readonly string[]} requires   // interface names only, never implementations
 * @property {(config: C, host: ModuleHost) => Promise<A>} create
 * @property {() => ModuleDiagnostics} diagnostics   // mandatory (§7.3)
 * @property {() => Promise<void>} dispose
 */
```

Master Plan §7 rules, unchanged: configuration is data (serializable, schema-validated, has
defaults, logged in full at startup); the absence of a module is a valid state (a stub, with a test
for the "deaf" build); diagnostics are mandatory; there are no singletons; the boundary is checked
by the build.

Loading: `core.js` reads the configuration (e.g. `{ graphics: null, audio: undefined }`), builds a
graph from `requires`, checks for cycles and missing names, creates modules in topological order,
and hands back the host. A broken graph is a configuration error, not a crash somewhere else.

## 7. check:boundaries

A homegrown checker (`scripts/check-boundaries.mjs`, zero dependencies), rules mandatory in CI:

- a directed graph: `layers/*` → `system/*` → nothing above it; no cycles;
- `vendor/v86` is imported only from `layers/cpu`;
- `system/*` doesn't know about layers (inversion: the contract lives in system, layers implement
  it);
- between layers, only through their interfaces — importing another layer's internals is
  forbidden;
- a layer doesn't import `core.js` (the facade is a consumer, not a dependency);
- test files (`*.test.js`) are not subject to the check.

A violation is a red build, no exceptions.

## 8. Stub layers for Phase 1

Every Phase 1 layer gets a directory, an interface (JSDoc + a description of its direct
responsibilities from Master Plan §8), and a stub: any method throws `NOT_IMPLEMENTED` with the
layer's name. The stubs' only function in Phase 0 is to populate the module graph and give the
boundary check something to work with. Implementing the interfaces is Phase 1–Phase 4 acceptance.

Layer responsibilities (brief excerpts from Master Plan §8, full text lives there):

| layer | responsibility | implemented in |
|---|---|---|
| cpu | bridge to v86: quantum, registers, breakpoints, physical memory; v86 patches live here | Phase 1 |
| memory | regions, permissions, typed accessors, leases, canaries | Phase 1 |
| kernel | threads, scheduler, time, synchronization, handles | Phase 2 |
| bridge | traps, marshaling, callbacks, asynchronous operations (parking is a type, §12.3) | Phase 3 |
| loader | PE, relocations, imports, TLS, in-guest module synthesis | Phase 1 |
| win32 | kernel32, user32, gdi32, advapi32, msvcrt, … | Phase 3 |
| log / filesystem / graphics / audio / input | dependency modules (✦) | Phase 4–Phase 7 |

## 9. Definition of Done for the init

Every item is checked by a command the script/CI already knows how to run:

1. clean clone → `npm ci` → `npm run build` → `dist/` matches the §5 contract, nothing extra;
2. `typecheck`, `lint`, `test`, `check:boundaries` — green, both locally and in CI;
3. `verify:reproducibility` — the vendor reproduces byte-for-byte in a clean container;
4. module-system unit tests: the graph builds, cycles are caught, module absence works, stubs
   answer `NOT_IMPLEMENTED`, `diagnostics()` is assembled across every module;
5. cdp_test: browser open, worker answers `ping`, screenshot in the report (the scenario from
   `phase-0-skeleton.md` §3.5).

## 10. What we deliberately do NOT do in this init

- don't run v86 as an emulator and don't execute a single guest instruction (Phase 1);
- don't write the PE loader, memory, threads (Phase 1–Phase 2);
- don't touch graphics/audio even with behavioral stubs (interfaces only, Phase 5–Phase 6);
- don't build the UI shell, the bundler, networking (Phase 8–Phase 9);
- cdp_test in this init is only the Phase 0 acceptance minimum; the full verb vocabulary grows from
  debugging sessions (Master Plan §16.7).
