# Bottlify

Bottlify runs original Win32 x86 games in the browser: cork, our own x86 → WebAssembly translator,
in a Web Worker, plus a from-scratch Win32/DirectX HLE layer on WebGPU, WebAudio and OPFS. No
plugins, no install, no server in the render path.

## Status

The engine runs end to end through one public call, `createApp()`, on a thread of its own: the
page keeps the canvas, the keyboard and mouse and the audio context; the worker keeps the
translator, the Win32 layer, the GPU device and the mixer. The loader maps a PE32 image and synthesises a real in-guest module per
system library, so an address from `GetProcAddress` is the one an import was bound to; threads run
under a scheduler whose quantum is retired guest instructions; the bridge marshals `stdcall`,
`cdecl` and `thiscall`, parks a caller that cannot be answered yet, calls back into guest code and
puts COM interfaces into guest memory; a program's files come out of a bundle read by byte range,
and what it writes persists as a session.

The drawing APIs present are DirectDraw, Direct3D 7, 8, 9 and 10 (with DXGI), OpenGL 1.x and
Vulkan, every one rendering through the same WebGPU backend. All of them are covered by unit and
contract tests and by byte-exact frame comparison against the backend's reference model; Direct3D
8 is additionally exercised on a real GPU by the browser harness (`tools/cdp_test/triangle.mjs`,
a committed fixture checked at named pixels). Sound goes through a mixer into a ring an
`AudioWorklet` reads; DirectSound and waveOut sit on top of it. Video decoding is an FFmpeg build
compiled to WebAssembly behind the DirectShow graph.

The list of supported games will be filled in later.

Every layer is real — `cpu`, `memory`, `kernel`, `bridge`, `loader`, `log`, `filesystem`, `win32`,
`graphics`, `audio`, `input`, `media` — and each is a module with a declared interface that the
build can run without.

## Quick start

```sh
npm ci
npm run typecheck && npm run lint && npm test && npm run check:boundaries
npm run fetch:video-decoder && npm run fetch:corpus   # the pinned decoder and the test corpus
npm run test:integration && npm run build
npm run cdp:probe   # boots the core in a real browser, checks the worker answers ping
```

The v86 emulator is not part of the repository or the package: `createApp({ engine: 'emulator',
v86: { moduleUrl, wasmBytes } })` runs it for a caller that brings its own build.

## Layout

- `modules/core/` — `@bottlify/core`, the engine package: `src/system/` is the module contract,
  `src/layers/<name>/` one directory per layer, `src/host/` the page and worker ends of
  `createApp`.
- `modules/cork/` — `@bottlify/cork`, the x86 → WebAssembly translator the core loads by URL.
- `modules/networking/`, `modules/installer/` — the Winsock relay, and adding a program by running
  its installer; each a workspace of its own.
- `tools/cdp_test/` — dev-only browser harness (`npm run cdp:probe`, `cdp:game`, `cdp:frames`).
- `docs/architecture.md` — how Bottlify works inside, with diagrams: the threads, cork, the DLLs
  built from JavaScript, graphics, sound, networking and storage
  ([Russian](docs/architecture.ru.md)).
- `docs/core/` — documentation of the core package: [`README.md`](docs/core/README.md) (start
  here), [`api.md`](docs/core/api.md), [`configuration.md`](docs/core/configuration.md) and
  [`limits.md`](docs/core/limits.md).
- `roadmap/` — the phase plans and the knowledge registers.

Licenses for vendored components: `THIRD-PARTY-NOTICES.md`. Bottlify is MPL-2.0.
