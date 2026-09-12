# Bottlify

Bottlify runs original Win32 x86 games in the browser: a forked [v86](https://github.com/mrwayer/v86)
for x86 emulation in a Web Worker, plus a from-scratch Win32/DirectX HLE layer on WebGPU, WebAudio
and OPFS. No plugins, no install, no server in the render path.

## Status

The engine runs end to end through one public call, `createApp()`, on a thread of its own: the
page keeps the canvas, the keyboard and mouse and the audio context; the worker keeps the emulator,
the Win32 layer, the GPU device and the mixer. A 64 KiB ROM of our own takes the CPU straight into
protected mode with no BIOS; the loader maps a PE32 image and synthesises a real in-guest module per
system library, so an address from `GetProcAddress` is the one an import was bound to; threads run
under a scheduler whose quantum is retired guest instructions; the bridge marshals `stdcall`,
`cdecl` and `thiscall`, parks a caller that cannot be answered yet, calls back into guest code and
puts COM interfaces into guest memory; a program's files come out of a bundle read by byte range,
and what it writes persists as a session.

Measured in this repository's own browser runs: **Warcraft III boots to its main menu and draws it
on a real GPU, with its music and sound.** That is one title, to its menu; nothing past it is
claimed.

The drawing APIs present are DirectDraw, Direct3D 7, 8, 9 and 10 (with DXGI), OpenGL 1.x and
Vulkan, every one rendering through the same WebGPU backend. Direct3D 8 is the one a real program
has exercised; the others are verified by the package's own tests — contract tests against observed
behaviour and byte-exact frame comparison — and not yet by a title. Sound goes through a mixer into
a ring an `AudioWorklet` reads; DirectSound and waveOut sit on top of it. Video decoding is an
FFmpeg build compiled to WebAssembly behind the DirectShow graph.

Every layer is real — `cpu`, `memory`, `kernel`, `bridge`, `loader`, `log`, `filesystem`, `win32`,
`graphics`, `audio`, `input`, `media` — and each is a module with a declared interface that the
build can run without.

## Quick start

```sh
npm ci
npm run typecheck && npm run lint && npm test && npm run check:boundaries
npm run fetch:v86 && npm run fetch:video-decoder   # the pinned emulator and decoder binaries
npm run test:integration && npm run build
npm run cdp:probe   # boots the core in a real browser, checks the worker answers ping
```

Building the vendored v86 from source needs Docker (`npm run build:v86 -- --docker`, then
`npm run verify:reproducibility`); everyday development takes the prebuilt artifacts instead.

## Layout

- `modules/core/` — `@bottlify/core`, the engine package: `src/system/` is the module contract,
  `src/layers/<name>/` one directory per layer, `src/host/` the page and worker ends of
  `createApp`, `vendor/v86` the emulator submodule.
- `modules/networking/`, `modules/installer/` — the Winsock relay, and adding a title by running
  its installer; each a workspace of its own.
- `tools/cdp_test/` — dev-only browser harness (`npm run cdp:probe`, `cdp:game`, `cdp:frames`).
- `docs/core/` — documentation of the core package: [`README.md`](docs/core/README.md) is the
  index, with one document per layer, the module system, and `createApp`.
- `roadmap/` — the phase plans and the knowledge registers.

Licenses for vendored components: `THIRD-PARTY-NOTICES.md`. Bottlify is MPL-2.0.
