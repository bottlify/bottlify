System Instruction: Bottlify Architect

Project State

Bottlify runs original Win32 x86 games in the browser: a fork of v86 (x86 emulation in a Web
Worker) plus a from-scratch Win32/DirectX HLE layer on top of WebGPU/WebAudio/OPFS.

The phased plan is history: `roadmap/phases-history.md` holds the eleven phase documents' decisions
and what landed. Work is ordered by `roadmap/00-TODO-list.md` (local), which opens with the week's
goal; installers and networking are areas in it, not phases.

What runs today, end to end through `createApp()`: the default engine is cork, our own x86 → wasm
translator (`modules/cork`), which runs with nothing of the emulator loaded; the v86 emulator stays an
engine a launch selects by name (`emulator`, `hybrid`, `differential`), where a 64 KiB ROM of our own
(no BIOS) takes the CPU straight into protected mode, and the reference the differential suites judge
cork against. The loader maps a 32-bit PE and synthesises a real in-guest module per
system library, so an address from `GetProcAddress` is the one an import was bound to; threads run
under a round-robin scheduler whose quantum is retired guest instructions; the bridge marshals
stdcall, cdecl and thiscall, parks a caller that cannot be answered yet, calls back into guest code,
and puts COM interfaces into guest memory. **Warcraft III draws its main menu on a real GPU** —
a windowed program registers its class, pumps messages, mounts its archives, creates Direct3D 8
textures and presents lit, fogged frames.

Every layer is real: `cpu`, `memory`, `kernel`, `bridge`, `loader`, `log`, `filesystem`, `win32`,
`graphics`, `audio`, `input`, `media`. `win32` covers kernel32, msvcrt, user32, gdi32, advapi32 with
the registry, ole32, quartz, winmm, wsock32 and more; `graphics` covers DirectDraw, Direct3D 7, 8
and 9, OpenGL and the WebGPU backend they all render through.

Do not trust this paragraph over the tree. It has been stale before, and a claim here that the code
contradicts is a bug in this file.

Planning documents live in `roadmap/`. Only the `00-*` files are local: `.gitignore` excludes
`roadmap/00-*` and nothing else, because they are personal working-notes territory. Everything
else in there is tracked and ships with the repo, so it is written for a reader who is not you.

`roadmap/00-TODO-list.md` is the index: the week's goal and one local file per area —
`00-cork.md`, `00-v86.md`, `00-graphics.md`, `00-win32-kernel.md`, `00-audio-input.md`,
`00-installers-bundles.md`, `00-diagnostics.md` — each holding that area's open work followed by its
pitfalls (the hard-won bugs that each cost weeks; `00-pitfalls.md` maps the old section numbers to
files). `roadmap/00-product-plan.md` is the product around the engine (public API, launcher, accounts,
sharing, Steam, thresholds); `roadmap/00-references.md` is the external reading list. The product model, the rules and the layer graph are this file and `docs/core/`; the phase history is `roadmap/phases-history.md`.

The rest is split by what a document is for, rather than numbered in one sequence — a global
sequence forced a number on documents that were never a phase, and produced two files claiming the
same one:

- `roadmap/phases-history.md` — the eleven phase documents folded into one: the decisions kept
  verbatim, the history compressed to what landed and when.
- `roadmap/registers/` — consulted throughout rather than worked through: `carried-knowledge`,
  `defects-carried-forward`, `decisions-and-optimisations`, `porting`, `process-creation`,
  `ui-quick-start`.
- `roadmap/README.md` — the index, and the first thing to read.

The pitfalls sections of the area files (index: `roadmap/00-pitfalls.md`) are not optional reading before touching the kernel, bridge, graphics or
audio layers: it is the register of what has already cost weeks once.

This file is tracked and ships with the repo, so it is written for any checkout: no absolute paths,
no machine-specific setup. The durable reference for users of the package is `docs/core/` — versioned documentation of
`@bottlify/core`'s actual module contract, configuration, and current limitations, kept current as
phases land. Only the `00-*` files are local to this checkout; the rest of `roadmap/` travels with the repo.

Repo layout:
- `package.json` — workspace root (npm workspaces, `modules/*`).
- `modules/core/` — `@bottlify/core`. `src/system/` is the module contract/host/registry/config
  machinery; `src/layers/<name>/` is one directory per architectural layer (see graph below), each
  with `api.js` (JSDoc interface) + `module.js` (the `BottlifyModule` definition).
  `vendor/v86/` is the v86 submodule (see "Vendoring v86"). `scripts/` holds build, vendor-build,
  reproducibility-check and boundary-check tooling, all zero-dependency Node scripts.
- `tools/cdp_test/` — the Phase 0 acceptance harness: launches a headless Chromium via CDP, serves
  `modules/core/test/page/`, and asserts the worker answers a ping. Dev tooling; never imported by
  a package.
- `docs/core/` — durable, git-tracked documentation of `@bottlify/core`'s module contract,
  configuration shape and current limitations (kept up to date as phases land). This is the
  documentation written for someone outside the project, as against the roadmap's working plans.

1. Language & Runtime Contour (fixed for the whole Phase 0+ core package)

- **Vanilla ES modules + JSDoc, not TypeScript.** No transpilation step in development. Types are
  part of the contract and are enforced by `tsc --checkJs --noEmit` (`modules/core/jsconfig.json`),
  not by writing `.ts`. Where JSDoc can't express something, a `.d.ts` lives next to the code
  (ambient types only — no translated/compiled TS ships in the product).
- **WASM only where it's already required** — the vendored v86 emulator. Our own code is JS until
  profiling proves a hot path needs WASM (performance is a correctness concern, not a default).
- **Zero runtime dependencies** in `@bottlify/core`. Everything external is vendored inside the
  package (`vendor/v86`) or built into `dist/`; nothing in the running product does a network
  `fetch` for its own code.
- **Tests:** Node's built-in `node:test`, zero test dependencies, `*.test.js` colocated with the
  code it tests (no separate `test/` tree for unit tests — `modules/core/test/page/` is the
  cdp_test browser sandbox, not unit tests).

2. Ownership & Third-Party Code

- **v86 is the one external dependency we keep**, forked at `github.com/bottlify/v86`, vendored as a
  git submodule pinned to a specific commit (recorded in `modules/core/vendor/v86`'s submodule
  pointer). Patches to v86 live on our fork's own branch, one commit per patch, each a candidate to
  upstream — never edited in place inside `vendor/` without a corresponding fork commit.
- **Those patches are written from scratch, not adapted.** Knowing that a defect exists and where it
  lives is the valuable part and is worth taking from anywhere; the patch itself is ours, written
  against the behaviour of the code in `vendor/v86`. Verify the claim against that source first —
  a reported defect may already be fixed in the version we vendor, and acting on a second-hand
  description would then "fix" something that is not broken.
- **Wine is a source of knowledge, not code**: conformance-test expectations (which arguments
  succeed, which fail, what the observable semantics are) inform our HLE implementations; nothing is
  copied or translated from Wine's source.
- **Anything reused from someone else's work gets a `THIRD-PARTY-NOTICES.md` entry, in the same
  commit that introduces it** — not just whole vendored dependencies like v86. A smaller borrowed
  piece (an algorithm, a snippet, an approach lifted from a library, blog post, or another repo
  rather than written fresh for this project) is still someone else's work and still needs
  attribution there.

3. Six Rules the Whole Project Is Built On

These aren't aspirational — they're how disputes about a design get resolved, from Phase 0 through the
last phase.

1. **Modularity: every module is a standalone library.** A module has an interface (what it
   promises), a configuration (data, not code), a lifecycle (`create`/`diagnostics`/`dispose`), and
   its own tests. It knows about other modules only through their declared `requires` — never a
   direct import, never a shared singleton. The practical test: pull a module out, and the rest of
   the system still builds and runs, degraded but not broken (`graphics: null` → the game runs
   without rendering). `check:boundaries` enforces the dependency graph in CI; this is not
   negotiable by comment or convention.
2. **A layer is derived from its specification, not from a reference implementation.** Order of
   work: contract → test → implementation. The contract is the ABI, the signatures, the struct
   layout, the return codes, the edge-case behavior. A reference tree answers "how does real Windows
   behave", never "how do I write this".
3. **Everything is tested, including graphics** — unit, contract (Wine conformance expectations),
   graphical (reference-frame comparison), and end-to-end (the harness driving a real game). A layer
   without tests is not considered done.
4. **No per-game crutches.** Never branch on a game's name/exe/hash, never hardcode an offset for
   one title, never special-case a quirk to keep a single game limping along. Nearly every
   "this game doesn't work" symptom root-caused to a *generic* layer bug —
   FPU context-switch, `GetProcAddress` epoch, a DLU→px conversion, an mmap write-back gap, an
   async-callback invariant — and fixing the generic bug once helped every title on that path. If a
   game misbehaves, that's where to look.
5. **Performance is part of correctness.** A slow implementation doesn't faithfully reproduce how
   the app actually ran. Performance targets are set from day one and checked automatically (see
   `roadmap/00-product-plan.md`, Thresholds, for the actual numbers), not addressed "when there's
   time".
6. **Diagnostics are first-class from day one.** The harness, ring buffers, phase profiler and guest
   CPU attribution are built alongside the core, not bolted on later — because in this domain a bug
   is found by measurement, not by reading code. (The canonical example: a 9x FPS
   regression was one line of a buffer-locking contract; reading code didn't find it for months, a
   phase profiler found it in one run.)

4. The Module Contract (as implemented in `modules/core/src/system/`)

```js
/**
 * @typedef {Object} BottlifyModule
 * @property {string} name
 * @property {string} version
 * @property {readonly string[]} requires   // interfaces this module consumes — never implementations
 * @property {(config, host: ScopedModuleHost) => Promise<ModuleApi>} create
 * @property {() => ModuleDiagnostics} diagnostics   // required — no exceptions
 * @property {() => Promise<void>} dispose
 */
```

- `system/contract.js` — the JSDoc typedefs only; no runtime exports.
- `system/host.js` (`makeScopedHost`) — every module gets its own view: `requireApi(name)` only
  works for names in that module's own `requires`; `provide(name, api)` only accepts its own name.
  There is exactly one shared registry underneath, but no module ever sees more of it than its
  declared dependencies — this is what "no singletons between modules" means concretely.
- `system/registry.js` (`ModuleRegistry`) — turns a `{ moduleName: boolean | object }` configuration
  into a topologically-ordered creation plan. A disabled module that nothing needs is dropped
  entirely; a disabled module that something *does* need is installed as a stub instead (so the
  interface is always bound for whoever requires it). Cycles and unknown names are configuration
  errors, not runtime surprises.
- `system/stub.js` — `NOT_IMPLEMENTED` for any method on a disabled or not-yet-built module. Every
  layer under `src/layers/*/module.js` is a stub today; implementing a layer means replacing its
  `module.js`/`api.js` while keeping the same `name`/`requires` contract the registry and
  `check:boundaries` already enforce.

Layer dependency graph (enforced by `scripts/check-boundaries.mjs`, not just documented):

```
cpu → vendor/v86, log (only cpu may import vendor/) log → (nothing)
memory → cpu, log                                   filesystem → log
kernel → cpu, memory, log                           loader → cpu, memory, log
bridge → cpu, kernel, memory, log
win32 → bridge, kernel, memory, loader, filesystem, log
graphics / audio / input → win32, bridge, memory
```

`system/*` never imports `layers/*` (contract lives in `system/`, layers implement it — not the
other way round); a layer imports another layer only if it's declared in `requires`; nothing outside
`src/` is importable except `vendor/` through `layers/cpu`; the whole `src/` import graph must be
acyclic. All of this is checked by `npm run check:boundaries`, which parses the real `requires`
arrays out of each `module.js` rather than trusting a separately-maintained rule file.

5. Vendoring v86

- `modules/core/vendor/v86` is a git submodule of the fork, pinned to a specific commit — never
  "whatever HEAD happens to be". Updating it is a deliberate act: pull, rebuild, run the full
  regression/acceptance suite, then commit the new submodule pointer.
- The reproducible build path is Docker (`scripts/Dockerfile.v86` + `scripts/v86-make-and-hash.sh`,
  driven by `scripts/build-v86.mjs --docker`), because v86's own Makefile needs a full toolchain
  beyond `rustc`: Node (the `gen/generate_{jit,interpreter,analyzer}.js` scripts that emit
  `src/rust/gen/*.rs` before `cargo` ever runs), a JRE + `wget` (Closure Compiler, fetched by the
  Makefile's own rule on first use), `clang` targeting `wasm32` (the two C objects,
  `softfloat.c`/`zstddeclib.c`), `python3` (`tools/rust-lld-wrapper`), and the
  `wasm32-unknown-unknown` Rust target. **When bumping the v86 submodule or touching this pipeline,
  re-check its Makefile for new toolchain requirements before assuming the Dockerfile still
  covers it** — this is exactly the kind of gap that looks fine until someone actually runs the
  build (see `docs/core/` for the concrete gaps found and fixed at Phase 0 review time).
- `scripts/verify-reproducibility.mjs` rebuilds v86 in a clean container and diffs SHA-256 hashes
  against `dist/vendor/manifest.json` — anything but a byte-for-byte match fails the build. This is
  the enforcement of "Phase 0 acceptance: a clean clone builds reproducibly", not a nice-to-have.

5a. Optimisation Discipline

- **An optimisation works on a test before it touches the engine.** First a test that reproduces
  a scenario that really occurs -- in node, on the instructions a title actually runs (a block
  profile, the bytes from the bundle) -- then a proposed solution, and only when the solution
  works on that test is the engine changed, and the game run confirms it afterwards. A browser
  A/B run of a guess is not a diagnosis: a game's frame varies by a quarter from one run to the
  next.
- **Judge a change on more than one scenario** (play, menu, load): a change that made Doom 3's
  play 3% faster doubled the guest's time in its menu.
- **No hacks and no per-title hooks while another way exists.** The first lever is the translator
  itself -- more caching, larger and more complex blocks and regions -- because it speeds up every
  title at once. Small gains count when they are generic.

6. Comment Discipline

- Comments explain WHY — a non-obvious invariant, a workaround, something that would surprise a
  reader — never WHAT the code already says.
- No changelog-style comments (dates, one-off measured counts, "this used to do X, was fixed by Y").
  No removal tombstones — when code is deleted, delete it cleanly; the absence speaks for itself.
- Match the comment density of the surrounding code. A one-line note beats a paragraph; a paragraph
  beats a wall of history nobody asked for.
- **No claims about specific titles that this project did not measure.** Never write "this makes game
  X work" or quote a frame rate from someone else's run. If a property plausibly matters for real
  programs, say it may be needed for some titles and leave it to our own measurement; results from
  tests this project actually ran are facts and can be stated as such.
- **Committed artifacts never mention earlier projects or local machine paths** — that context
  belongs only in the local `roadmap/00-*` files.

7. Workflow

```
npm ci
npm run typecheck        # tsc --checkJs --noEmit over modules/core/src
npm run lint             # eslint.config.mjs — flat config, zero warnings tolerated
npm test                 # node --test "src/**/*.test.js"
npm run check:boundaries # scripts/check-boundaries.mjs — layer graph + acyclic import check
npm run build            # esbuild → modules/core/dist/, plus dist/checksums.json
npm run build:v86 -- --docker && npm run verify:reproducibility   # vendor pipeline (needs Docker)
npm run cdp:probe        # tools/cdp_test — browser → worker → ping → screenshot, the Phase 0 acceptance test
```

`eslint.config.mjs` turns `no-undef` off deliberately: `tsc --checkJs` already knows the real global
set for each file (Node script vs. Worker vs. browser page) and checks it more precisely than a
single ESLint environment could without per-file overrides duplicating that config. Everything else
in `eslint:recommended` stays on — it has already caught real dead code during Phase 0 review (an unused
helper function, a useless variable initializer).

CI (`.github/workflows/ci.yml`) runs three independent jobs: `core` (install → typecheck → lint →
test → check:boundaries → build), `probe` (the cdp_test acceptance scenario, with a real headless
Chrome), and `vendor` (the Docker v86 build + reproducibility check). All three must be green for a
change to land; a red `vendor` job on an unrelated change usually means the Dockerfile's toolchain
has drifted from what v86's Makefile actually needs — check there first, not in application code.

8. Delegating Work

**If a task splits into parts that do not depend on each other, run them in parallel.** Sequential
execution of independent work is wasted time, and this codebase produces such splits constantly:
a question to be answered by measurement, an implementation that needs no answer to proceed, and a
piece of tooling in its own folder are three streams that never touch.

What has actually parallelised well here:

- **Investigations that read a lot and return a conclusion.** "Can the emulator be preempted at an
  instruction count?" and "what exactly must a context switch save?" were answered concurrently by
  two agents while a third stream of implementation continued. Their intermediate reading never had
  to enter the main conversation — only the finding did.
- **Work confined to a folder nobody else touches.** A UI in `ui/`, a spike in the scratchpad.
- **Anything whose output is a report rather than a diff.**

What does not: two streams editing the same files, or a design that one investigation is about to
change. Sequence those instead — and when a finding lands that invalidates the plan, update the plan
before continuing, not after.

Rules that keep concurrent work from colliding:

- **Give each agent an exclusive area and say so explicitly.** Name what it may create and forbid
  everything else — shared files (`package.json`, `eslint.config.mjs`) are wired by the parent
  afterwards, never by an agent, because two agents editing one file is the collision.
- **An investigation writes only to the scratchpad.** It may read anything and import the repo's own
  modules read-only, but a spike that leaves nothing behind cannot conflict with anything.
- **Brief the constraints, or they are violated in good faith.** The house style, the lint warning
  cap, "do not commit", "do not run a repo-wide autofix". An agent that does not know the cap exists
  will add warnings and break the build for everyone.
- **Require verification, and require honesty about its absence.** Ask for "say plainly if you could
  not verify this" — a report that assumes success is worse than no report.
- **Verify a second-hand claim before acting on it.** One reported defect in the emulator turned out
  not to apply to the version we vendor; acting on the description would have "fixed" something that
  was not broken.

Choosing the agent kind:

- A **fork** inherits the whole conversation — the constraints, the style, what was already tried.
  It always runs on the parent's model; a model override is ignored. This is the right default here,
  because the briefing is the expensive part.
- A **named type** starts cold and *can* take a model override, which is worth it for mechanical
  work that needs little context. Pay for the full briefing when you do this: it knows nothing.

9. Forward-Looking: No Per-Game Hacks (repeated because it will be tempting)

Once Phase 1+ lands real x86 execution and Win32 surfaces, the single most valuable thing this project
holds to is rule 4 above. A bring-up bug is a diagnostic signal about
our recreation of a generic contract, never a target to patch around for one title. When a game
does something unexpected, the question is "what is the real API contract here, and what are we
doing differently" — not "how do I make this one executable proceed".

10. When a Step Ends (mandatory)

A step of agreed work ends in one of two ways and no other: **its solution is found** --
implemented, tested, verified on what it was for -- or **it has reached a dead end** -- every
approach tried was refuted by measurement and no next approach is known. The report says which of
the two it is, with the evidence.

- A status report before that is a line in the middle of the work, not the end of a turn: give the
  numbers, then start the next step in the same turn.
- Never end on "if you don't object, I'll do X", "shall I start?", or a menu of options for a goal
  that is already set. Choose the next step and take it.
- The only other reasons to stop: a decision that is genuinely the user's -- a direction not yet
  chosen, an irreversible or outward-facing action -- or a wait a rule imposes, such as a rebuild
  on the user's host. Then say what is waiting on what.
