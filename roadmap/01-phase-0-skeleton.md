# 01 — Phase 0: Skeleton. Roadmap

> Phase working document. Source of truth — `00-bottlify-master-plan.md` (hereafter the Master
> Plan). Here: concrete steps, artifacts, and acceptance for Phase 0. All decisions are recorded in
> this file, not in code comments.

## 0. What Phase 0 is

Phase 0 = the "Skeleton" from the Master Plan (§Phase 0, Appendix A, steps 1–4). The phase's job is
not to write the core, but to build the machine on which the core will be written: repository,
build, CI, the vendored v86, the module skeleton, and cdp_test, which drives a browser. Core code
(CPU, memory, loader) is Phase 1; it doesn't belong here.

**Phase acceptance (from the Master Plan):** clean clone → build → test → browser opens, worker
answers `ping`. Repeatable, and in CI — not "works on my machine."

## 1. Decisions fixed at the outset

The technology contour is set by the project owner and recorded in writing. Deviations are allowed
only by editing this section, never verbally.

| decision | value | consequences |
|---|---|---|
| code language | vanilla ES modules (JS) + JSDoc types | no transpilation in development; types are part of the contract, checked by `tsc --checkJs` |
| WASM | only where needed | the v86 emulator (Rust → wasm); our own code is JS until profiling proves otherwise (Master Plan §3.5) |
| monorepo | one repository, npm workspaces | packages under `modules/*` |
| first package | `@bottlify/core` in `modules/core/` | described in `02-phase-0-core-module.md` |
| v86 fork | https://github.com/mrwayer/v86, as a submodule at `modules/core/vendor/v86` | pinned to a commit; updating is a deliberate act, not "just pulled" |
| core distribution | `modules/core/dist/`: core itself + all external refs | the bundle is self-contained, no CDN/network fetches at runtime |
| module boundary | checked by the build (`check:boundaries`) | an import bypassing the interface breaks CI (Master Plan §7.5) |
| `modules/` boundary | product modules only | dev tools live in `tools/`, never in `modules/` |
| cdp_test | a Node dev tool, CDP to Chrome | lives in `tools/cdp_test/`, stays a dev tool |
| CI | GitHub Actions, run on every commit | reproducibility is a readiness criterion, not a bonus |
| tests | `node:test` (Node's built-in runner), `*.test.js` next to the code | zero test dependencies; `node --test "src/**/*.test.js"`; running in a browser comes later |

Note on the Master Plan: the sample module contract in §7 is written in TypeScript. The "vanilla
JS" contour changes the form, not the substance: the contract is expressed as JSDoc typedefs, the
same strictness — `checkJs` + `noEmit` in CI. The amendment is documented here (the Master Plan is
a source of knowledge, not dogma; §4).

**References.** What a layer must do comes from the contract it implements: the Win32 ABI, the
documented semantics of each API, and the conformance expectations that describe how a real
implementation behaves at the edges. How it is written is ours. No implementation is adapted from
another codebase; the specification answers "what should happen", never "how do I write this"
(Master Plan §4).

## 2. Target repository structure at the end of the phase

```
bottlify/
├── roadmap/                        # plans (this folder)
├── modules/
│   └── core/                       # @bottlify/core — described in 02-phase-0-core-module.md
│       ├── package.json
│       ├── src/
│       │   ├── core.js             # facade: assemble the module system from configuration
│       │   ├── system/             # module system: contract, ModuleHost, registry
│       │   └── layers/             # cpu/ memory/ kernel/ bridge/ loader/ win32/ — interfaces + stubs
│       ├── vendor/v86/             # mrwayer/v86 submodule (pinned to a commit)
│       ├── scripts/                # build:v86, verify:reproducibility, check:boundaries
│       ├── dist/                   # generated; contract — see 02 §5
│       └── *.test.js               # tests next to layer code (02 §2/§3)
├── tools/
│   └── cdp_test/                  # CDP tool, Phase 0 minimum (§5)
├── .github/workflows/ci.yml
├── package.json                    # workspace root
└── THIRD-PARTY-NOTICES.md          # licenses and attribution (Master Plan, Part VIII)
```

## 3. Steps

### P0.1 — Monorepo, package skeleton, CI

Root `package.json` with workspaces (`modules/*`), a single lockfile, the `@bottlify/core` package
with the structure from `02-phase-0-core-module.md` (without the vendor and without dist for now). An
editor ESLint config, `typecheck` (`tsc --checkJs --noEmit`) from the first commit. GitHub Actions:
one job per commit (install → typecheck → lint → test → check:boundaries), plus a separate vendor
reproducibility job once P0.2 exists.

**Done when:** clean clone → `npm ci` → `npm run typecheck && npm test` — green, in CI.

### P0.2 — Vendor v86

As a submodule at `modules/core/vendor/v86` (fork of mrwayer/v86, branch `master`, HEAD pinned in
this document at vendoring time). The `build:v86` script builds the artifacts (libv86.js, v86.wasm,
BIOS) and places them in `dist/vendor/`; `verify:reproducibility` spins up a clean container and
requires byte-for-byte identical hashes. Patch policy and upstreaming order — `02-phase-0-core-module.md`
§4. `THIRD-PARTY-NOTICES.md` — from day one: v86 BSD-2-Clause with the copyright preserved
(Master Plan, Part VIII).

**Done when:** `npm run build:v86` from a clean clone gives a byte-identical `dist/vendor/`,
verified in a CI container.

### P0.3 — Module system: contract and skeleton

Implementation of the Master Plan §7 contract in vanilla JS: the `BottlifyModule` JSDoc typedef,
`ModuleHost` (the single point of contact between modules, no singletons), a registry, loading by
configuration, mandatory `diagnostics()`, stubs for every Phase 1 layer (cpu, memory, kernel,
bridge, loader, win32). The absence of a module is a valid state: the system builds without
`graphics` and works as a "deaf" circuit (Master Plan §7.2). `check:boundaries`
(dependency-cruiser): a directed graph, no cycles, vendor reachable only from the cpu layer.

**Done when:** module-system tests are green; an import that bypasses a layer's head breaks CI; a
build without the audio module succeeds and answers `diagnostics()`.

### P0.4 — cdp_test (before the core code)

`tools/cdp_test/`, in Node: launch/attach to Chrome over CDP, open a test page, RPC into the
worker, `ping`, a state snapshot, a screenshot, run and verify a step chain. The Phase 0 minimum is
defined by phase acceptance, but two rules are baked in from the start because they are cheap now
and expensive to retrofit: the `--autoplay-policy=no-user-gesture-required` flag at browser startup
(without a real gesture an audio context stays suspended, which will silently stall audio-gated
logic in Phase 6), and "edit the worker → reload the page, not HMR." The full cdp_test verb vocabulary (breakpoints, rings, surface dumps) is
a growth target from Master Plan §16 and Part VI; not written in Phase 0.

**Done when:** the end-to-end check accepted below runs from the command line and in CI.

### P0.5 — Phase 0 acceptance

End-to-end scenario: clean clone → `npm ci` → build (including vendor) → tests → `check:boundaries`
→ cdp_test opens a browser, the page brings up a worker, the worker answers `ping`, a screenshot is
saved to the report. The scenario is repeatable: as a CI job and locally with a single command.

**Done when:** acceptance passes from scratch on a clean machine/runner, three times in a row.

## 4. Order and dependencies

P0.1 → P0.2 ∥ P0.3 → P0.5; P0.4 starts right after P0.1 (in parallel with P0.2/P0.3) — this is
exactly "cdp_test before the core code." P0.2 and P0.3 can start in parallel: they share no
dependency besides P0.1.

## 5. What is deliberately NOT part of Phase 0

- Not a single line of x86 execution: the bridge to v86, memory, the PE loader — that's Phase 1.
- No UI whatsoever (@bottlify/ui — much later, Phase 8.1).
- Installer parsers and bundle formats (Master Plan §10a — out of scope for the project; the
  bundler is Phase 8).
- Networking (@bottlify/networking — Phase 9).
- Setting up domain hosting and COOP/COEP policies (Master Plan §12) — needed by Phase 6/8; the
  Phase 0 test page doesn't require them.
