# `@bottlify/core`

Durable, git-tracked documentation of the core package: what it is, how a consumer uses it, what
each layer promises, and where it stops. Written from the tree as it stands and updated as work
lands; `roadmap/` holds the plans, this holds the contract.

## What the package is

`@bottlify/core` runs an original Win32 x86 program in a browser tab. It is an x86 machine — a
fork of v86, compiled to WebAssembly and vendored inside the package — with a Win32 and DirectX
layer written from scratch on top of it. There is no Windows underneath: a 64 KiB ROM of the
package's own takes the CPU straight into 32-bit protected mode, the loader maps the program's PE
image and synthesises a real in-guest module for every system library, and the emulated CPU
executes the program's own code. A call that leaves the program for `kernel32`, `user32`, `gdi32`,
`ddraw`, `d3d8`, `dsound` or any other system library traps into the host and is answered by one of
the layers below. Rendering goes out through WebGPU, sound through WebAudio, the program's files
come from a bundle read by byte range and its writes persist in OPFS. A bundle may carry
`hooks.json` and `hooks.mjs` beside its `manifest.json` -- never inside the bundle itself -- for
the bridge's slot-hook mechanism ([`bridge.md`](./bridge.md), [`loader.md`](./loader.md)'s
"Sidecar hooks"): a way to replace a guest function's implementation with host code without
naming a title anywhere in this package.

The engine runs in a Web Worker. The page keeps the canvas, the keyboard and mouse, and the audio
context; everything else — emulator, HLE, GPU device, mixer — is on a thread of its own.

## Using it

```js
import { createApp } from '@bottlify/core';

const app = await createApp({
    executable,                                    // Uint8Array: the program
    v86: { moduleUrl, wasmBytes },                 // the emulator, shipped in the package
    canvas,                                        // or `container`, or neither
    bundle: { url, id, store: 'local' },           // a .btl, by URL, read a range at a time
    storage: 'opfs',                               // where the session goes
    audio: { drained: true },                      // something reads the sound ring
});
app.on('frame', ({ width, height }) => {});
app.input.attach(canvas);
const speaker = new AudioWorkletNode(context, 'bottlify-output', {
    processorOptions: { ...app.audio.memory(), channels: app.audio.format().channels },
});
const code = await app.run();
```

Every option, the message protocol between page and worker, the controller's members, what is
asynchronous and why, `host: 'thread'` for tests, and the current limitations of the host are in
[`host.md`](./host.md). The emulator and decoder binaries are subpath exports of the package
(`@bottlify/core/libv86.mjs`, `@bottlify/core/v86.wasm`, `@bottlify/core/video-decoder.wasm`,
`@bottlify/core/worklet.js`, `@bottlify/core/engine.worker.js`); a bundler resolves them like the
entry point.

## The layers

The package is twelve modules, one directory each under `src/layers/`, assembled by the module
system described in [`system.md`](./system.md). Each has a document of its own:

| layer | one line | document |
|---|---|---|
| `cpu` | The vendored emulator behind an interface: boot from the package's own ROM, run for a quantum of instructions, registers, physical memory, the FPU, the I/O-port trap channel. The only layer that may import `vendor/`. | [`cpu.md`](./cpu.md) |
| `memory` | The guest address space as regions with permissions, and typed accessors every host read and write goes through. | [`memory.md`](./memory.md) |
| `kernel` | Threads, a round-robin scheduler whose quantum is retired guest instructions, context switch, synchronisation objects with timed waits, the handle table, a virtual clock. | [`kernel.md`](./kernel.md) |
| `bridge` | The trap channel's host half: calls marshalled by convention (`stdcall`, `cdecl`, `thiscall`), a caller parked when the answer is not ready, calls back into guest code, COM interfaces published into guest memory, recorded sessions replayed in tests. | [`bridge.md`](./bridge.md) |
| `loader` | Maps a PE32 image, relocations, imports and delay-loads, TLS, and synthesises an in-guest module per system library so `GetProcAddress` answers the address an import was bound to. | [`loader.md`](./loader.md) |
| `log` | The journal: levels and categories, ring buffers, a phase profiler, guest CPU attribution. Requires nothing. | [`log.md`](./log.md) |
| `filesystem` | A virtual volume with a bundle behind it, read on demand block by block, with an OPFS block cache, and the session overlay a program writes into. | [`filesystem.md`](./filesystem.md) |
| `win32` | The guest-facing system libraries: `kernel32`, `user32`, `gdi32`'s bookkeeping half, `advapi32` with the registry, `ole32`, `oleaut32`, `msvcrt`, `ntdll`, `winmm`, `wsock32`/`ws2_32`, `shell32`, `comctl32`, `comdlg32`, `imm32`, `version`, `wininet`, and a DirectShow filter graph (`quartz`). | [`win32.md`](./win32.md) |
| `graphics` | Every drawing API over one WebGPU backend: GDI's drawing half, DirectDraw, Direct3D 7, 8, 9 and 10 with DXGI, OpenGL 1.x with WGL, Vulkan; each published through a seam that is the library's own exports and vtables. | [`graphics.md`](./graphics.md) |
| `audio` | A mixer over a shared track table an `AudioWorklet` resamples and sums, or -- without shared memory -- a ring the engine thread mixes into itself; DirectSound buffers and cursors on top of it; the MPEG provider a sound middleware loads, hosted. | [`audio.md`](./audio.md) |
| `input` | Keyboard, mouse and gamepad from the page, routed into both readings a program takes: the window message queue and DirectInput's polled state. | [`input.md`](./input.md) |
| `media` | Video and picture decoding for what a program plays: an FFmpeg build compiled to WebAssembly behind open/decode/pull, and a hosted JPEG library. Its own layer because a clip is both picture and sound. | [`media.md`](./media.md) |

Which layer a guest-visible DLL lives in, and how a DLL whose two halves sit in different layers is
joined, is in [`infrastructure.md`](./infrastructure.md).

## The module contract, in brief

A module is `{ name, version, requires, create(config, host), diagnostics(), dispose() }`. It sees
other modules only through the host it is given in `create`, which answers `requireApi(name)` for
names in its own `requires` and nothing else. A configuration of `{ [name]: boolean | object }`
becomes a topologically ordered build plan; a disabled module that something needs is installed as
a stub whose every method throws `NOT_IMPLEMENTED`. `scripts/check-boundaries.mjs` reads the real
`requires` arrays and fails the build on any import that crosses an undeclared edge. All of it is
in [`system.md`](./system.md), with the dependency table as the code declares it.

## Building and testing

From the repository root (`package.json` is an npm workspace over `modules/*`):

| command | what it does |
|---|---|
| `npm ci` | Installs the dev toolchain. The package has no runtime dependencies. |
| `npm run typecheck` | `tsc --checkJs --noEmit` over the source; types are JSDoc. |
| `npm run lint` | ESLint flat config, zero warnings tolerated. |
| `npm test` | Node's `node:test` over every `*.test.js` colocated with its code, across the workspaces. |
| `npm run test:integration` | `*.itest.js`: whole programs from `test/fixtures/` run through the engine, needing the prebuilt emulator. |
| `node scripts/build-fixtures.mjs` (in `modules/core`) | Rebuilds the compiled fixtures (`seh.exe`, `cxxeh.exe`, `unhandled.exe`) from `test/fixtures/src/` with clang, lld-link and llvm-dlltool against the MSVC ABI -- no Microsoft toolchain. Only after changing a source; the executables are committed, and the build is byte-reproducible. |
| `npm run check:boundaries` | The layer graph and the acyclic import check. |
| `npm run fetch:v86`, `npm run fetch:video-decoder` | Pull the pinned emulator and decoder binaries into `vendor/prebuilt/`, verified against their lock files. |
| `npm run build` | esbuild → `dist/core.js`, `dist/engine.worker.js`, `dist/worklet.js`, `dist/vendor/*`, `dist/checksums.json`. |
| `npm run build:v86 -- --docker` and `npm run verify:reproducibility` | Rebuild the emulator from the submodule in a container and diff its hashes against the manifest. Not needed day to day. |
| `npm run cdp:probe` | Launches a headless Chromium, boots the core in a worker, checks it answers a ping. |
| `npm run cdp:game`, `npm run cdp:frames` | Drive a program bundle in a real browser on a real GPU; report what a run cost, and where a frame's time goes once the program has settled. Development tooling in `tools/cdp_test/`, not tests. |

CI runs `core` (typecheck, lint, tests, boundaries, integration tests, build) and `probe` on every
push; `vendor` (the containerised v86 build and reproducibility check) runs when its own inputs
change and on a schedule.

## Current limitations

- **What is verified is what the tests and the harness cover.** Every layer has unit and
  contract tests; the drawing APIs are checked by byte-exact frame comparison against the WebGPU
  backend's reference model; the browser harness in `tools/cdp_test/` runs the engine in a real
  Chromium on a real GPU, where only Direct3D 8 has a committed fixture (`triangle.mjs`). The
  other drawing APIs have no real-GPU fixture yet. The list of supported games will be filled in
  later.
- **Some options cannot cross to the worker.** Function-valued options (`watchImport`, `sample`,
  `onCall`, a storage provider, a `bundle.fetch`) are only reachable by importing the engine
  directly; `storage: 'local'` needs `localStorage`, which a worker lacks; pointer lock is not
  exposed through the controller. See [`host.md`](./host.md) §9.
- **The mixer's pump runs on the engine's thread.** Output is on the audio thread; the rest of the
  audio layer waits for a measurement that says it should move (`host.md` §9).
- **The preemption point is one compiled block wide.** A slice is bounded by retired instructions,
  but the emulator compiles per page and a hot loop inside one block runs to that block's end
  regardless of the quantum.
- **No stray pointer faults.** Without paging every address in RAM is readable and writable,
  the null page included, so a program counting on an access violation from a bad pointer
  carries on instead. Every other processor exception reaches the program's handlers
  ([`win32.md`](./win32.md), "Exceptions").
- **An image is mapped as one span** with the widest access its sections ask for
  (`src/layers/loader/module.js`); per-section permissions wait until something other than the
  loader writes there.
- **The video decoder is optional and not in git.** `npm run fetch:video-decoder` pulls it against
  `video-decoder-lock.json`; a build without it comes up and the media layer reports
  `available() === false`, and a program that opens a clip gets the filter graph's truthful
  refusal.

## Toolchain notes

Generic enough to bite other npm-workspaces + `tsc --checkJs` projects:

- **A transitive devDependency can break `tsc --checkJs` on unrelated files.** `@types/node`'s
  `process.d.ts` contains `typeof import("punycode")`. Its ambient `declare module "punycode"` only
  applies when no real `punycode` package resolves on disk; the moment a devDependency pulls one in
  (`eslint` → `ajv` → `uri-js` → `punycode`), TypeScript resolves the real, untyped file and, with
  `checkJs`, type-checks it. Fixed with a `compilerOptions.paths` remap (`jsconfig.json` →
  `types/punycode.d.ts`). `skipLibCheck` does not help: the offending file is `.js`.
- **A pinned build image needs the target's full toolchain.** The vendored v86's `Makefile` needs,
  beyond `rustc`: Node (the `gen/` scripts run before `cargo`), a JRE and `wget` (Closure Compiler),
  `clang` targeting `wasm32`, `python3`, and the `wasm32-unknown-unknown` Rust target.
  `scripts/Dockerfile.v86` carries all of them.
- **ESLint's `no-undef` is off deliberately.** Source runs in three global environments (Node
  scripts, a worker, a page) and `tsc --checkJs` already derives the right global set per file;
  everything else in `eslint:recommended` stays on.
