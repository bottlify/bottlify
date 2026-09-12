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

`assembleModules(config)` (`src/core.js`) is the entry point into the module system — internal
machinery rather than the package's product API (see "Public surface" below). It builds a
`ModuleRegistry` from
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

`assembleModules` takes `{ [moduleName]: boolean | object | undefined }` (`src/system/config.js`):

| value                | meaning                                                              |
|-----------------------|-----------------------------------------------------------------------|
| `undefined` / `true`  | module enabled, default configuration                                 |
| `false` / `null`      | module disabled — dropped entirely, *unless* something else needs it  |
| an object             | module enabled with that configuration (validated by the module)      |
| anything else         | configuration error, thrown before any module is created              |

A disabled module that another active module `requires` is not silently omitted: it's installed as
a stub (see below) so the interface stays bound and the requiring module never has to special-case
"my dependency doesn't exist". An unknown module name anywhere in the configuration is an error.

## Public surface

What a consumer imports is deliberately not the module machinery above:

```js
// the runtime itself -- no framework; runs the engine in a worker of its own
import { createApp } from '@bottlify/core';

const app = await createApp({
    executable,                                    // Uint8Array: the program
    v86: { moduleUrl, wasmBytes },                 // the emulator's artifacts
    canvas,                                        // or `container`, or neither
    bundle: { url, id, store: 'local' },           // a .btl, by URL, read a range at a time
    storage: 'opfs',                               // where the session goes
    audio: { drained: true, sampleRate },          // something reads the ring
    host: 'worker',                                // or 'thread'
});
app.on('frame', ({ width, height }) => { /* the viewport's own pixels */ });
app.input.attach(canvas);                          // keyboard and mouse, on the page
const speaker = new AudioWorkletNode(context, 'bottlify-output', {
    processorOptions: { ...app.audio.ring().memory, channels: app.audio.format().channels },
});
const code = await app.run();
```

`createApp` runs on the page and builds everything between the program and the browser: it
spawns the engine worker (`engine.worker.js`, shipped beside `core.js` and found relative to it;
`workerUrl` overrides that for a bundler that moves files), adopts the `canvas` it is given --
or makes one in `container` -- and transfers its control to the worker, opens the GPU device in
the worker and presents every frame straight into that canvas, captures keyboard and mouse on
the canvas and posts them, forwards the page's visibility to the worker for pacing only, and hands
back the sound ring's shared memory for the page's audio worklet. What it returns is the same
controller either way: `run`, `pause`, `resume`, `stop`, `dispose`, `on`, `attachLog`,
`diagnostics`, `log`, `audio`, `input`, `session`, `registry`, `presented`, `trace`.

### Where the engine runs: `host`

- `worker` (the default wherever `Worker` exists): the emulator, the Win32 layer, the mixer's
  pump and the GPU device all live on a thread of their own. The page does nothing per frame.
  The run loop keeps the page's pacing by default -- a yield every turn, a short look while
  idle -- because that is what measured best; `pacing: 'event'` asks for the loop a thread of
  its own allows instead: turns back to back until a host answer, a range or a message from
  the page is pending, and an idle machine asleep until the guest's own next deadline -- a
  timed wait, a queue timer, a device that wants feeding -- or until the page speaks. The page
  counts what it posts in one shared word (when the origin has shared memory) so the worker
  sees a waiting message between two turns without yielding to find out. Measured on a real
  title's menu, the event-driven loop woke once per host answer for turns that retired nothing
  and ran at half the page pacing's throughput; it stays available for the change that batches
  those wakes.
- `thread`: the same engine behind the same port protocol on the calling thread, with the
  page's own pacing (a yield every turn, a short look while idle) because that thread cannot
  block. This is what a test, a headless run and `?engine=src` debugging use, and what a
  runtime without `Worker` falls back to.

A canvas can transfer its control once, so the host it was handed to is kept for as long as the
canvas is: disposing a program leaves its worker ready, and the next `createApp` on the same
canvas starts in it.

### What became asynchronous

Anything that crosses the thread boundary answers with a promise, in both host modes, so a
consumer writes against one shape:

| call | answers |
|---|---|
| `run()`, `pause()`, `resume()`, `stop()`, `dispose()` | `Promise` |
| `diagnostics()`, `trace()`, `presented()` | `Promise` |
| `log.setLevel()`, `log.setDefaultLevel()`, `log.profile()`, `log.frames()` | `Promise` |
| `log.recent()`, `log.drain()` | synchronous, from a mirror of the journal the page keeps in step a few times a second |
| `audio.ring()`, `audio.format()` | synchronous; the ring's memory was handed over at start |
| `session.export()`, `registry()` | synchronous, once `run()` has resolved: what the exit left behind travels with it (files only with `collectOnExit`) |
| `on()`, `input.*`, `attachLog()` | synchronous |

Options that could not cross a thread are named by what they are built from: a bundle by its
`url` rather than a fetch function, a seeded volume by `storage: { files }`, a watch by
`watch: { libraries, strings }`, hooks by `hooks: [{ module, offset, label, argBytes, lengths }]`,
the device's diagnostic knobs by `device: { fog, mips, skipTexture, ... }` with no device object.

A React binding (`AppProvider`, `Viewport`, `useApp`) is still an open question: a
`@bottlify/core/react` subpath keeps one version and one release; a separate package keeps the
dependency graph cleaner for non-React consumers. The core package stays framework-agnostic
either way, and nothing in its vocabulary is named after games: this is a Win32 runtime, and games
are the target use case, not the subject.

## What is built, and what is not

| layer | state |
|---|---|
| `cpu` | Boots the guest with our own ROM instead of a BIOS, straight into 32-bit protected mode; runs, stops, registers, physical memory, the FPU, and the I/O-port trap channel the guest calls out through. |
| `memory` | Region map (overlap-checked, permissioned, `protect()`) plus typed accessors; every host access to guest memory goes through it. |
| `loader` | Maps a PE32 image, applies relocations, binds the import and the delay-load directories, and synthesises a real in-guest module per system library -- export directory and trampolines -- so a program that resolves a name at run time finds our implementation at the address its import was bound to. |
| `kernel` | Threads with a stack and a context each, a round-robin scheduler whose quantum is retired guest instructions, one context-switch primitive, events, mutexes and semaphores with timed waits, the handle table, and a virtual clock credited with the time the guest really ran. |
| `bridge` | The trap channel's host half: a call is marshalled by its calling convention, invoked, and its result placed -- or the caller is parked and says so with a token nothing else can produce. It calls the other way too, into guest code, and publishes COM interfaces into guest memory. |
| `filesystem` | A tree with a bundle behind it: a game's installation is read on demand, block by block, and a read whose blocks are not resident yet answers with a promise the bridge parks the guest on. |
| `win32` | kernel32, msvcrt, user32 (classes, windows, the message queue), gdi32's bookkeeping half, advapi32 with the registry, ole32, winmm, wsock32, imm32, shell32, comctl32, comdlg32, version, wininet, ntdll, and a DirectShow filter graph that reports honestly that it cannot render a format nothing here decodes. |
| `graphics` | Draws. DirectDraw, Direct3D 7 and Direct3D 8 seams over a WebGPU backend; a guest program's triangle is rendered on a real GPU and checked byte-for-byte against named pixels. |
| `audio` | The wave-out surface feeds a mixer, which converts every source to one format and writes ahead into a ring in shared memory; a WebAudio worklet reads the other end, and its read index is what a program's play cursor is built on. DirectSound models its buffers and their cursors but does not yet reach the mixer. |
| `input` | Keyboard, mouse and gamepad, routed into both readings a Win32 program takes at once -- the window message queue and DirectInput's polled state. |
| `media` | An FFmpeg build compiled to WebAssembly, wrapped as open/decode/pull: one clip at a time, video frames as BGRA and audio as signed 16-bit. It is its own layer because a clip is both at once and belongs to neither the drawing nor the sound API. |
| `log` | Ring buffers, a phase profiler, and guest CPU attribution. |

A stub is still a valid state, not a gap to route around: a build with a layer disabled comes up and
reports itself. Implementing one means replacing its `module.js` behind the same `name`/`requires`
contract -- the registry, host scoping and boundary checker do not change.

Known limitations worth stating plainly:

- **No video is decoded yet.** The filter graph exists and refuses, and the decoder that would let
  it stop refusing is built but not yet wired to it. The decoder's WebAssembly artifact is not in
  git: `npm run fetch:video-decoder` downloads it against a lock file
  (`modules/core/video-decoder-lock.json`) from a release of the FFmpeg fork that builds it. A
  build without it comes up and reports `available() === false`.
- **A frame is presented, a game is not yet playable.** One real title boots end to end -- it maps
  its own libraries, opens its archives, creates a device and presents -- and stops short of its
  menu. That is where the work is.
- **The preemption point is one page wide.** A slice is bounded by retired instructions, but the
  emulator compiles per 4 KiB page and a hot loop inside one compiled block runs to the end of that
  block regardless of the quantum asked for.
- **The image is mapped as one span** with the widest access its sections ask for; per-section
  permissions wait until something other than the loader writes there.
- **Module state is per-process, not per-build.** `diagnostics()` is part of the module contract and
  has to answer after `create`, so a module keeps its instance state on itself; a second concurrent
  build in one process would collide.

The only concrete engine dependency wired in is the vendored v86 submodule
(`modules/core/vendor/v86`, pinned by commit) -- reachable, by construction (`check:boundaries`),
only from `src/layers/cpu/`.

## Toolchain gotchas worth keeping

Kept here because they are generic enough to bite other npm-workspaces + `tsc --checkJs`
projects, not just this one:

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
